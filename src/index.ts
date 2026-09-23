import { Telegraf, Markup } from "telegraf";
import http from "http";
import dotenv from "dotenv";
import { pool, initDb } from "./db";
import { RESTAURANT, ADMIN_IDS, MENU } from "./config";
import {
  getCart,
  addToCart,
  removeFromCart,
  clearCart,
  cartTotal,
  getDraft,
  setDraft,
  clearDraft,
} from "./cart";

dotenv.config();

http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment variables.");
}

const bot = new Telegraf(BOT_TOKEN);

const adminPriceEdit = new Map<number, string>();
const remindedUsers = new Set<number>();

// The first ID in config.ts's ADMIN_IDS is the permanent super admin.
// Only this account can add or remove other admins — this is fixed at
// startup and does NOT change even if it's later removed from the DB
// admins table, so you can never accidentally lock yourself out.
const SUPER_ADMIN_ID = Number(ADMIN_IDS[0]);

// Restaurant name/address/bank info now live in the DB (see `settings`
// table below) instead of being hardcoded in config.ts, so admins can
// change them from inside Telegram. This in-memory copy is loaded at
// startup and kept in sync whenever an admin edits a value.
const runtimeSettings = {
  name: RESTAURANT.name,
  address: RESTAURANT.location,
  bankAccount: RESTAURANT.bank.account,
  bankAccountName: RESTAURANT.bank.accountName,
};

// Admin Telegram IDs now live in the DB `admins` table instead of the
// static ADMIN_IDS array, so the super admin can add/remove admins from
// inside Telegram without redeploying. Cached in memory for fast checks.
const adminIdsCache = new Set<number>();

// Tracks which field (name/address/bank account/bank name/new admin ID)
// an admin is currently typing a new value for, via the /settings menu.
type SettingsEditType = "name" | "address" | "bank_account" | "bank_name" | "add_admin";
const adminEditState = new Map<number, { type: SettingsEditType }>();

bot.catch((err, ctx) => {
  console.error(`Bot error for update type ${ctx.updateType}:`, err);
});

// ─────────────────────────────────────────────
// SETTINGS & ADMINS (DB-BACKED)
// ─────────────────────────────────────────────

async function ensureSettingsTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      telegram_id BIGINT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getSetting(key: string): Promise<string | null> {
  const result = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return result.rows.length ? result.rows[0].value : null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

async function loadSettings(): Promise<void> {
  runtimeSettings.name = (await getSetting("restaurant_name")) ?? RESTAURANT.name;
  runtimeSettings.address = (await getSetting("restaurant_address")) ?? RESTAURANT.location;
  runtimeSettings.bankAccount = (await getSetting("bank_account")) ?? RESTAURANT.bank.account;
  runtimeSettings.bankAccountName =
    (await getSetting("bank_account_name")) ?? RESTAURANT.bank.accountName;
}

async function loadAdmins(): Promise<void> {
  const result = await pool.query(`SELECT telegram_id FROM admins`);
  adminIdsCache.clear();
  for (const row of result.rows) adminIdsCache.add(Number(row.telegram_id));

  // First run: seed the DB from config.ts's ADMIN_IDS so existing admins
  // keep working without any manual setup.
  if (adminIdsCache.size === 0) {
    for (const id of ADMIN_IDS) {
      const numId = Number(id);
      adminIdsCache.add(numId);
      await pool.query(
        `INSERT INTO admins (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING`,
        [numId]
      );
    }
  }

  // Super admin is always an admin, even if somehow removed from the DB.
  adminIdsCache.add(SUPER_ADMIN_ID);
}

function isAdmin(userId: number) {
  return adminIdsCache.has(Number(userId));
}

function isSuperAdmin(userId: number) {
  return Number(userId) === SUPER_ADMIN_ID;
}

async function settingsKeyboard(userId: number) {
  const rows: any[] = [
    [Markup.button.callback("🏪 የሬስቶራንት ስም ቀይር", "settings_name")],
    [Markup.button.callback("📍 አድራሻ ቀይር", "settings_address")],
    [Markup.button.callback("🏦 የባንክ ሂሳብ ቁጥር ቀይር", "settings_bank_account")],
    [Markup.button.callback("👤 የባንክ ሂሳብ ስም ቀይር", "settings_bank_name")],
    [Markup.button.callback("📋 የአድሚን ዝርዝር", "settings_list_admins")],
  ];
  if (isSuperAdmin(userId)) {
    rows.push([
      Markup.button.callback("➕ አድሚን ጨምር", "settings_add_admin"),
      Markup.button.callback("➖ አድሚን አስወግድ", "settings_remove_admin"),
    ]);
  }
  rows.push([Markup.button.callback("✔️ ዝጋ", "settings_close")]);
  return Markup.inlineKeyboard(rows);
}

async function removeAdminKeyboard() {
  const rows = [...adminIdsCache]
    .filter((id) => id !== SUPER_ADMIN_ID)
    .map((id) => [Markup.button.callback(`➖ ${id}`, `rm_admin_${id}`)]);
  if (rows.length === 0) {
    rows.push([Markup.button.callback("(ከዋና አድሚን በቀር ሌላ አድሚን የለም)", "noop")]);
  }
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────────
// MARQUEE
// ─────────────────────────────────────────────

async function getMarquee(): Promise<string> {
  const result = await pool.query(
    `SELECT message, expires_at FROM marquee WHERE id = 1`
  );
  if (result.rows.length === 0) return "";
  const row = result.rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return "";
  return row.message || "";
}

async function setMarquee(message: string, hours: number): Promise<void> {
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO marquee (id, message, expires_at)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET message = $1, expires_at = $2`,
    [message, expiresAt]
  );
}

function animateMarquee(text: string): string {
  return `📢 〈 ${text} 〉`;
}

async function buildHeader(): Promise<string> {
  const marquee = await getMarquee();
  if (!marquee) return "";
  return `${animateMarquee(marquee)}\n${"─".repeat(30)}\n`;
}

// ─────────────────────────────────────────────
// MENU AVAILABILITY & PRICE HELPERS
// ─────────────────────────────────────────────

async function getAvailability(): Promise<Record<string, boolean>> {
  const result = await pool.query(
    `SELECT item_id, available FROM menu_availability`
  );
  const map: Record<string, boolean> = {};
  for (const row of result.rows) {
    map[row.item_id] = row.available;
  }
  return map;
}

async function getPriceOverrides(): Promise<Record<string, number>> {
  const result = await pool.query(
    `SELECT item_id, price FROM menu_price_overrides`
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) {
    map[row.item_id] = Number(row.price);
  }
  return map;
}

async function setPrice(itemId: string, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO menu_price_overrides (item_id, price)
     VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET price = $2`,
    [itemId, price]
  );
}

async function getAvailableMenu() {
  const avail = await getAvailability();
  const prices = await getPriceOverrides();
  return MENU.filter((item) => avail[item.id] !== false).map((item) => ({
    ...item,
    price: prices[item.id] ?? item.price,
  }));
}

async function toggleAvailability(itemId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT available FROM menu_availability WHERE item_id = $1`,
    [itemId]
  );
  const current = result.rows.length === 0 ? true : result.rows[0].available;
  const next = !current;
  await pool.query(
    `INSERT INTO menu_availability (item_id, available)
     VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET available = $2`,
    [itemId, next]
  );
  return next;
}

// ─────────────────────────────────────────────
// MENU TEXT & KEYBOARDS
// ─────────────────────────────────────────────

async function buildMenuText(userId: number): Promise<string> {
  const header = await buildHeader();
  const cart = getCart(userId);
  let body = `🍽 እንኳን ወደ ${runtimeSettings.name} በሰላም መጡ!\n\n📍 ${runtimeSettings.address}\nለማዘዝ ምግብ ይምረጡ:`;
  if (cart.length > 0) {
    const lines = cart.map(
      (i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`
    );
    const total = cartTotal(userId);
    body = `🛒 የተመረጡ ምግቦች:\n${lines.join("\n")}\n\nድምር: ${total} ብር\n\n${"─".repeat(16)}\nለማዘዝ ምግብ ይምረጡ:`;
  }
  return header + body;
}

async function menuKeyboard(userId: number) {
  const availableItems = await getAvailableMenu();
  const buttons = availableItems.map((item) =>
    Markup.button.callback(
      `${item.name} — ${item.price} ብር`,
      `add_${item.id}`
    )
  );
  const rows: any[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  const cart = getCart(userId);
  if (cart.length > 0) {
    const total = cartTotal(userId);
    rows.push([
      Markup.button.callback(
        `🛒 ዝርዝር ይመልከቱ | ✅ ትዕዛዝ ጨርስ — ${total} ብር`,
        "checkout"
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

function cartKeyboard(userId: number) {
  const cart = getCart(userId);
  const rows: any[] = cart.map((item) => [
    Markup.button.callback(`${item.name} x${item.quantity}`, "noop"),
    Markup.button.callback("➖", `remove_${item.id}`),
    Markup.button.callback("➕", `add_${item.id}`),
  ]);
  rows.push([Markup.button.callback("✅ ትዕዛዝ ጨርስ", "checkout")]);
  rows.push([Markup.button.callback("🍽 ወደ ምግብ ዝርዝር ተመለስ", "back_to_menu")]);
  return Markup.inlineKeyboard(rows);
}

async function manageMenuKeyboard() {
  const avail = await getAvailability();
  const prices = await getPriceOverrides();
  const rows: any[] = [];
  for (const item of MENU) {
    const isAvailable = avail[item.id] !== false;
    const icon = isAvailable ? "✅" : "❌";
    const price = prices[item.id] ?? item.price;
    rows.push([
      Markup.button.callback(
        `${icon} ${item.name} — ${price} ብር`,
        `toggle_${item.id}`
      ),
      Markup.button.callback("💰 ዋጋ ቀይር", `price_${item.id}`),
    ]);
  }
  rows.push([Markup.button.callback("✔️ ተጠናቋል", "manage_done")]);
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────────
// DAILY RESET (6:00 AM)
// ─────────────────────────────────────────────

function scheduleDailyReset() {
  function msUntil(hour: number, minute = 0): number {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  setTimeout(async () => {
    try {
      await pool.query(
        `UPDATE orders SET status = 'archived'
         WHERE status IN ('pending_payment', 'payment_submitted')
           AND created_at < CURRENT_DATE`
      );
      remindedUsers.clear();
      for (const adminId of adminIdsCache) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `🌅 እንኳን ደህና አደሩ!\n\nአዲስ ቀን ተጀምሯል — ትዕዛዞች ዳግም ጀምሯል። ✅`
          );
        } catch {}
      }
      console.log("Daily reset done.");
    } catch (err) {
      console.error("Daily reset error:", err);
    }
    scheduleDailyReset();
  }, msUntil(6, 0));
}

// ─────────────────────────────────────────────
// NIGHTLY REPORT (9:00 PM)
// ─────────────────────────────────────────────

function scheduleNightlyReport() {
  function msUntil(hour: number, minute = 0): number {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  setTimeout(async () => {
    try {
      await sendNightlyReport();
    } catch (err) {
      console.error("Nightly report error:", err);
    }
    scheduleNightlyReport();
  }, msUntil(21, 0));
}

async function sendNightlyReport() {
  const result = await pool.query(
    `SELECT
       o.id,
       o.customer_name,
       o.customer_phone,
       o.order_type,
       o.total_amount,
       o.status,
       o.created_at,
       STRING_AGG(oi.item_name || ' x' || oi.quantity, ', ') AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.created_at >= CURRENT_DATE
       AND o.status IN ('payment_submitted', 'confirmed', 'pending_payment')
     GROUP BY o.id
     ORDER BY o.created_at ASC`
  );

  const orders = result.rows;
  const today = new Date().toLocaleDateString("en-GB");

  if (orders.length === 0) {
    for (const adminId of adminIdsCache) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `🌙 የምሽት ሪፖርት — ${today}\n\nዛሬ ምንም ትዕዛዝ አልተቀበለም።`
        );
      } catch {}
    }
    return;
  }

  const totalRevenue = orders.reduce(
    (sum: number, o: any) => sum + Number(o.total_amount),
    0
  );
  const confirmed = orders.filter((o: any) => o.status === "confirmed").length;
  const submitted = orders.filter((o: any) => o.status === "payment_submitted").length;
  const pending = orders.filter((o: any) => o.status === "pending_payment").length;

  const divider = `┼${"─".repeat(4)}┼${"─".repeat(14)}┼${"─".repeat(12)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼`;
  const header  = `│ #  │ ደንበኛ         │ ስልክ        │ አይነት    │ ብር       │`;
  const top     = `┌${"─".repeat(4)}┬${"─".repeat(14)}┬${"─".repeat(12)}┬${"─".repeat(10)}┬${"─".repeat(10)}┐`;
  const bottom  = `└${"─".repeat(4)}┴${"─".repeat(14)}┴${"─".repeat(12)}┴${"─".repeat(10)}┴${"─".repeat(10)}┘`;

  const rows = orders.map((o: any) => {
    const name  = (o.customer_name  || "—").substring(0, 12).padEnd(12);
    const phone = (o.customer_phone || "—").substring(0, 10).padEnd(10);
    const type  = (o.order_type === "delivery" ? "ዴሊቨሪ" : "ፒክአፕ").padEnd(8);
    const amt   = String(o.total_amount).padEnd(8);
    const id    = String(o.id).padEnd(2);
    return `│ ${id} │ ${name} │ ${phone} │ ${type} │ ${amt} │`;
  });

  const statusLine = (emoji: string, label: string, count: number) =>
    `${emoji} ${label}: ${count} ትዕዛዝ`;

  const report =
    `🌙 *የምሽት ሪፖርት — ${today}*\n` +
    `${"═".repeat(34)}\n\n` +
    `📊 *ማጠቃለያ*\n` +
    `${statusLine("✅", "ተረጋግጧል", confirmed)}\n` +
    `${statusLine("💳", "ክፍያ ተልኳል", submitted)}\n` +
    `${statusLine("⏳", "ክፍያ ይጠበቃል", pending)}\n` +
    `💰 *ጠቅላላ ገቢ: ${totalRevenue} ብር*\n\n` +
    `📋 *የትዕዛዝ ዝርዝር*\n` +
    `\`\`\`\n` +
    `${top}\n` +
    `${header}\n` +
    `${divider}\n` +
    rows.join(`\n${divider}\n`) +
    `\n${bottom}\n` +
    `\`\`\`\n\n` +
    `🍽 *${runtimeSettings.name}*`;

  for (const adminId of adminIdsCache) {
    try {
      await bot.telegram.sendMessage(adminId, report, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      console.error(`Failed to send nightly report to admin ${adminId}:`, err);
    }
  }
}

// ─────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────

bot.start(async (ctx) => {
  console.log("Telegram user ID:", ctx.from.id);
  clearCart(ctx.from.id);
  clearDraft(ctx.from.id);
  remindedUsers.delete(ctx.from.id);
  const availableItems = await getAvailableMenu();
  if (availableItems.length === 0) {
    const header = await buildHeader();
    return ctx.reply(
      header +
        `እንኳን ደህና መጡ ወደ ${runtimeSettings.name}! 🍽\n${runtimeSettings.address}\n\nየምግብ ዝርዝሩ አሁን አይገኝም። እባክዎ ቆየት ብለው ይሞክሩ!`
    );
  }
  ctx.reply(await buildMenuText(ctx.from.id), await menuKeyboard(ctx.from.id));
});

bot.command("menu", async (ctx) => {
  ctx.reply(await buildMenuText(ctx.from.id), await menuKeyboard(ctx.from.id));
});

// Lets anyone (admin or not) get their own Telegram numeric ID — handy
// for the super admin to grab a person's ID before adding them via
// /settings → ➕ አድሚን ጨምር.
bot.command("id", (ctx) => {
  ctx.reply(`🆔 የቴሌግራም ID: ${ctx.from.id}`);
});

bot.command("manage", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply("የምግብ ዝርዝር ያስተዳድሩ — ለመቀየር ይጫኑ:", await manageMenuKeyboard());
});

bot.command("settings", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply(
    `⚙️ ማዋቀሪያ\n\n` +
      `የአሁኑ መረጃ፦\n` +
      `🏪 ስም: ${runtimeSettings.name}\n` +
      `📍 አድራሻ: ${runtimeSettings.address}\n` +
      `🏦 ሂሳብ ቁጥር: ${runtimeSettings.bankAccount}\n` +
      `👤 የሂሳብ ስም: ${runtimeSettings.bankAccountName}\n\n` +
      `ለመቀየር ይምረጡ:`,
    await settingsKeyboard(ctx.from.id)
  );
});

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const orderId = parseInt(ctx.message.text.split(" ")[1], 10);
  if (!orderId) return ctx.reply("አጠቃቀም: /confirm <order_id>");
  await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]);
  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  if (order) {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `ትዕዛዝ #${orderId} ተረጋግጧል! ${runtimeSettings.name} እያዘጋጀ ነው። 🍽`
    );
  }
  ctx.reply(
    `✅ ትዕዛዝ #${orderId} ተረጋግጧል።\n\n💬 ለደንበኛው ለመልስ: /reply ${orderId} <መልዕክት>`
  );
});

bot.command("reply", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) {
    return ctx.reply(
      "አጠቃቀም: /reply <order_id> <መልዕክት>\nምሳሌ: /reply 42 ትዕዛዝዎ እየተዘጋጀ ነው!"
    );
  }
  const orderId = parseInt(parts[1], 10);
  if (isNaN(orderId)) {
    return ctx.reply("ትክክለኛ የትዕዛዝ ቁጥር ያስገቡ። ምሳሌ: /reply 42 መልዕክት");
  }
  const message = parts.slice(2).join(" ");
  const orderResult = await pool.query(
    `SELECT customer_telegram_id, customer_name FROM orders WHERE id = $1`,
    [orderId]
  );
  if (orderResult.rows.length === 0) {
    return ctx.reply(`ትዕዛዝ #${orderId} አልተገኘም።`);
  }
  const order = orderResult.rows[0];
  try {
    await bot.telegram.sendMessage(
      order.customer_telegram_id,
      `📨 *${runtimeSettings.name}:*\n\n${message}`,
      { parse_mode: "Markdown" }
    );
    ctx.reply(`✅ መልዕክት ለ ${order.customer_name} (ትዕዛዝ #${orderId}) ተልኳል።`);
  } catch (err) {
    console.error("Failed to send reply to customer:", err);
    ctx.reply("❌ መልዕክት መላክ አልተቻለም። ደንበኛው ቦቱን አቁሞ ሊሆን ይችላል።");
  }
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const result = await pool.query(
    `SELECT id, customer_name, order_type, total_amount, status, created_at
     FROM orders
     WHERE created_at >= CURRENT_DATE
     ORDER BY created_at DESC LIMIT 10`
  );
  if (result.rows.length === 0) return ctx.reply("ዛሬ ምንም ትዕዛዝ የለም።");
  const lines = result.rows.map(
    (o: any) =>
      `#${o.id} — ${o.customer_name} — ${o.order_type} — ${o.total_amount} ብር — ${o.status}`
  );
  ctx.reply(lines.join("\n"));
});

bot.command("report", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await sendNightlyReport();
});

bot.command("setmarquee", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) {
    return ctx.reply(
      "አጠቃቀም: /setmarquee <ሰዓት> <መልዕክት>\nምሳሌ: /setmarquee 3 ዛሬ ልዩ ቅናሽ አለ!"
    );
  }
  const hours = parseFloat(parts[1]);
  if (isNaN(hours) || hours <= 0) {
    return ctx.reply("እባክዎ ትክክለኛ ሰዓት ያስገቡ። ምሳሌ: /setmarquee 2 መልዕክት");
  }
  const message = parts.slice(2).join(" ");
  await setMarquee(message, hours);
  ctx.reply(`✅ ማርኬ ተቀጥሏል!\n\n📢 "${message}"\n⏱ ለ ${hours} ሰዓት ይታያል።`);
});

bot.command("clearmarquee", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await pool.query(`UPDATE marquee SET message = '', expires_at = NULL WHERE id = 1`);
  ctx.reply("✅ ማርኬ ተሰርዟል።");
});

// ─────────────────────────────────────────────
// SETTINGS ACTIONS
// ─────────────────────────────────────────────

bot.action("settings_name", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  adminEditState.set(ctx.from.id, { type: "name" });
  await ctx.answerCbQuery();
  await ctx.reply(`🏪 አዲሱን የሬስቶራንት ስም ይላኩ (የአሁኑ: ${runtimeSettings.name}):`);
});

bot.action("settings_address", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  adminEditState.set(ctx.from.id, { type: "address" });
  await ctx.answerCbQuery();
  await ctx.reply(`📍 አዲሱን አድራሻ ይላኩ (የአሁኑ: ${runtimeSettings.address}):`);
});

bot.action("settings_bank_account", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  adminEditState.set(ctx.from.id, { type: "bank_account" });
  await ctx.answerCbQuery();
  await ctx.reply(`🏦 አዲሱን የባንክ ሂሳብ ቁጥር ይላኩ (የአሁኑ: ${runtimeSettings.bankAccount}):`);
});

bot.action("settings_bank_name", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  adminEditState.set(ctx.from.id, { type: "bank_name" });
  await ctx.answerCbQuery();
  await ctx.reply(`👤 አዲሱን የባንክ ሂሳብ ስም ይላኩ (የአሁኑ: ${runtimeSettings.bankAccountName}):`);
});

bot.action("settings_list_admins", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  await ctx.answerCbQuery();
  const lines = [...adminIdsCache].map((id) =>
    id === SUPER_ADMIN_ID ? `👑 ${id} (ዋና አድሚን)` : `👤 ${id}`
  );
  await ctx.reply(`📋 የአድሚን ዝርዝር:\n\n${lines.join("\n")}`);
});

bot.action("settings_add_admin", async (ctx) => {
  if (!isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery("የዋና አድሚን ብቻ ስልጣን አለው።");
  adminEditState.set(ctx.from.id, { type: "add_admin" });
  await ctx.answerCbQuery();
  await ctx.reply(
    "➕ አዲሱን አድሚን የቴሌግራም ID ይላኩ።\n\n" +
      "ID ለማግኘት: አዲሱ ሰው ቦቱን ከፍቶ /id ብሎ ይላክልዎት።"
  );
});

bot.action("settings_remove_admin", async (ctx) => {
  if (!isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery("የዋና አድሚን ብቻ ስልጣን አለው።");
  await ctx.answerCbQuery();
  await ctx.reply("➖ የትኛውን አድሚን ማስወገድ ይፈልጋሉ?", await removeAdminKeyboard());
});

bot.action(/^rm_admin_(\d+)$/, async (ctx) => {
  if (!isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery("የዋና አድሚን ብቻ ስልጣን አለው።");
  const targetId = Number(ctx.match[1]);
  if (targetId === SUPER_ADMIN_ID) {
    return ctx.answerCbQuery("ዋና አድሚን ሊወገድ አይችልም።");
  }
  await pool.query(`DELETE FROM admins WHERE telegram_id = $1`, [targetId]);
  adminIdsCache.delete(targetId);
  await ctx.answerCbQuery("ተወግዷል ✅");
  try {
    await ctx.editMessageText(`✅ አድሚን ${targetId} ተወግዷል።`);
  } catch {}
});

bot.action("settings_close", async (ctx) => {
  await ctx.answerCbQuery("ተዘግቷል");
  try {
    await ctx.editMessageText("⚙️ ማዋቀሪያ ተዘግቷል።");
  } catch {}
});

// ─────────────────────────────────────────────
// ADMIN MENU ACTIONS
// ─────────────────────────────────────────────

bot.action(/^toggle_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  const itemId = ctx.match[1];
  const newState = await toggleAvailability(itemId);
  const item = MENU.find((m) => m.id === itemId);
  await ctx.answerCbQuery(`${item?.name} አሁን ${newState ? "✅ አለ" : "❌ የለም"}`);
  try {
    await ctx.editMessageReplyMarkup((await manageMenuKeyboard()).reply_markup);
  } catch {}
});

bot.action("manage_done", async (ctx) => {
  await ctx.answerCbQuery("ተጠናቋል!");
  try {
    await ctx.editMessageText("የምግብ ዝርዝር በተሳካ ሁኔታ ተዘምኗል። ✅");
  } catch {}
});

bot.action(/^price_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("አልተፈቀደም።");
  const itemId = ctx.match[1];
  const item = MENU.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("ምግቡ አልተገኘም።");
  adminPriceEdit.set(ctx.from.id, itemId);
  await ctx.answerCbQuery();
  await ctx.reply(`${item.name} አዲስ ዋጋ ያስገቡ (በቁጥር ብቻ):`);
});

// ─────────────────────────────────────────────
// CUSTOMER ACTIONS
// ─────────────────────────────────────────────

bot.action(/^add_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const itemId = ctx.match[1];
  const availableMenu = await getAvailableMenu();
  const item = availableMenu.find((m) => m.id === itemId);
  if (!item) return ctx.answerCbQuery("ይቅርታ፣ ይህ ምግብ አሁን አይገኝም።");
  addToCart(userId, item);
  await ctx.answerCbQuery(`${item.name} ታክሏል ✅`);

  if (!remindedUsers.has(userId)) {
    remindedUsers.add(userId);
    await ctx.reply(`👆 ምግብዎን ከመረጡ በኋላ ✅ ትዕዛዝ ጨርስ የሚለውን ይጫኑ!`);
  }

  try {
    await ctx.editMessageText(
      await buildMenuText(userId),
      await menuKeyboard(userId)
    );
  } catch {}
});

bot.action(/^remove_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1];
  removeFromCart(ctx.from.id, itemId);
  await ctx.answerCbQuery("ተወግዷል");
  await showCart(ctx);
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(
      await buildMenuText(ctx.from.id),
      await menuKeyboard(ctx.from.id)
    );
  } catch {}
});

async function showCart(ctx: any) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    try {
      return ctx.editMessageText(
        await buildMenuText(userId),
        await menuKeyboard(userId)
      );
    } catch {
      return ctx.reply(await buildMenuText(userId), await menuKeyboard(userId));
    }
  }
  const lines = cart.map(
    (i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`
  );
  const total = cartTotal(userId);
  const header = await buildHeader();
  const text =
    header + `🛒 የምግብ ዝርዝርዎ:\n\n${lines.join("\n")}\n\nድምር: ${total} ብር`;
  try {
    await ctx.editMessageText(text, cartKeyboard(userId));
  } catch {
    await ctx.reply(text, cartKeyboard(userId));
  }
}

// ─────────────────────────────────────────────
// CHECKOUT FLOW
// ─────────────────────────────────────────────

bot.action("checkout", async (ctx) => {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  if (cart.length === 0) {
    return ctx.answerCbQuery("የምግብ ዝርዝርዎ ባዶ ነው።");
  }
  await ctx.answerCbQuery();
  setDraft(userId, {});
  await ctx.reply(
    "ዴሊቨሪ ይፈልጋሉ ወይስ እራስዎ ይወስዳሉ?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🚗 ዴሊቨሪ", "order_type_delivery")],
      [Markup.button.callback("🏪 እራሴ እወስዳለሁ", "order_type_pickup")],
    ])
  );
});

bot.action(/^order_type_(delivery|pickup)$/, async (ctx) => {
  const userId = ctx.from.id;
  const orderType = ctx.match[1] as "delivery" | "pickup";
  setDraft(userId, { ...getDraft(userId), orderType });
  await ctx.answerCbQuery();
  if (orderType === "delivery") {
    await ctx.reply("እባክዎ ያሉበትን አድራሻዎን ይላኩ:");
  } else {
    await ctx.reply("እባክዎ ሙሉ ስምዎን ይላኩ:");
  }
});

// ─────────────────────────────────────────────
// TEXT HANDLER
// ─────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // ── Settings edits (name/address/bank info/new admin ID) ──
  if (isAdmin(userId) && adminEditState.has(userId)) {
    const state = adminEditState.get(userId)!;
    const raw = ctx.message.text.trim();

    if (state.type === "add_admin") {
      if (!isSuperAdmin(userId)) {
        adminEditState.delete(userId);
        return;
      }
      if (!/^\d+$/.test(raw)) {
        return ctx.reply("የቴሌግራም ID ቁጥር ብቻ (ለምሳሌ 123456789) መሆን አለበት። እባክዎ እንደገና ይላኩ:");
      }
      const newAdminId = Number(raw);
      await pool.query(
        `INSERT INTO admins (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING`,
        [newAdminId]
      );
      adminIdsCache.add(newAdminId);
      adminEditState.delete(userId);
      await ctx.reply(`✅ አድሚን ${newAdminId} ታክሏል።`);
      try {
        await bot.telegram.sendMessage(
          newAdminId,
          `🎉 እንኳን ደስ አለዎት! የ${runtimeSettings.name} አድሚን ሆነዋል።\n\nየአድሚን ትዕዛዞችን ለማየት /manage ወይም /settings ይጫኑ።`
        );
      } catch {}
      return;
    }

    if (!raw) {
      return ctx.reply("ባዶ መሆን የለበትም። እባክዎ እንደገና ይላኩ:");
    }

    if (state.type === "name") {
      await setSetting("restaurant_name", raw);
      runtimeSettings.name = raw;
      adminEditState.delete(userId);
      return ctx.reply(`✅ የሬስቶራንት ስም ወደ "${raw}" ተቀይሯል።`);
    }

    if (state.type === "address") {
      await setSetting("restaurant_address", raw);
      runtimeSettings.address = raw;
      adminEditState.delete(userId);
      return ctx.reply(`✅ አድራሻ ወደ "${raw}" ተቀይሯል።`);
    }

    if (state.type === "bank_account") {
      await setSetting("bank_account", raw);
      runtimeSettings.bankAccount = raw;
      adminEditState.delete(userId);
      return ctx.reply(`✅ የባንክ ሂሳብ ቁጥር ወደ "${raw}" ተቀይሯል።`);
    }

    if (state.type === "bank_name") {
      await setSetting("bank_account_name", raw);
      runtimeSettings.bankAccountName = raw;
      adminEditState.delete(userId);
      return ctx.reply(`✅ የባንክ ሂሳብ ስም ወደ "${raw}" ተቀይሯል።`);
    }
  }

  if (isAdmin(userId) && adminPriceEdit.has(userId)) {
    const itemId = adminPriceEdit.get(userId)!;
    const raw = ctx.message.text.trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return ctx.reply("እባክዎ ትክክለኛ ዋጋ (አዎንታዊ ቁጥር) ያስገቡ:");
    }
    await setPrice(itemId, Number(raw));
    adminPriceEdit.delete(userId);
    const item = MENU.find((m) => m.id === itemId);
    return ctx.reply(`${item?.name} ዋጋ ወደ ${raw} ብር ተቀይሯል ✅`);
  }

  const draft = getDraft(userId);
  if (!draft.orderType) return;

  if (draft.orderType === "delivery" && !draft.deliveryAddress) {
    setDraft(userId, { ...draft, deliveryAddress: ctx.message.text });
    return ctx.reply("እባክዎ ሙሉ ስምዎን ይላኩ:");
  }

  if (!draft.customerName) {
    setDraft(userId, { ...draft, customerName: ctx.message.text });
    return ctx.reply("እባክዎ ስልክ ቁጥርዎን ይላኩ:");
  }

  if (!draft.customerPhone) {
    const phone = ctx.message.text.trim();
    if (!/^(09|07)\d{8}$/.test(phone)) {
      return ctx.reply(
        "የስልክ ቁጥሩ ትክክል አይደለም። ቁጥሩ በ09 ወይም 07 መጀመር እና 10 አሃዝ መሆን አለበት። እባክዎ እንደገና ይላኩ:"
      );
    }
    const updatedDraft = { ...draft, customerPhone: phone };
    setDraft(userId, updatedDraft);
    await finalizeOrder(ctx, updatedDraft);
    return;
  }
});

// ─────────────────────────────────────────────
// FINALIZE ORDER
// ─────────────────────────────────────────────

async function finalizeOrder(ctx: any, draft: ReturnType<typeof getDraft>) {
  const userId = ctx.from.id;
  const cart = getCart(userId);
  const total = cartTotal(userId);

  const result = await pool.query(
    `INSERT INTO orders (customer_telegram_id, customer_name, customer_phone, order_type, delivery_address, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment') RETURNING id`,
    [
      userId,
      draft.customerName,
      draft.customerPhone,
      draft.orderType,
      draft.deliveryAddress ?? null,
      total,
    ]
  );
  const orderId = result.rows[0].id;

  for (const item of cart) {
    await pool.query(
      `INSERT INTO order_items (order_id, item_id, item_name, item_price, quantity)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, item.id, item.name, item.price, item.quantity]
    );
  }

  setDraft(userId, { ...draft, awaitingScreenshotFor: orderId });

  const summary = cart
    .map((i) => `• ${i.name} x${i.quantity} — ${i.price * i.quantity} ብር`)
    .join("\n");

  await ctx.reply(
    `ትዕዛዝ #${orderId} ተቀብለናል! ✅\n\n${summary}\n\nድምር: ${total} ብር\n\n` +
      `እባክዎ ወደ ሂሳብ ቁጥሩ ያስተላልፉ:\n🏦 የኢትዮጵያ ንግድ ባንክ (CBE)\n` +
      `ሂሳብ ቁጥር: ${runtimeSettings.bankAccount}\n` +
      `ስም: ${runtimeSettings.bankAccountName}\n\n` +
      `ክፍያ ከፈጸሙ በኋላ የክፍያ ስክሪንሾት እዚህ ይላኩ።`
  );

  clearCart(userId);
}

// ─────────────────────────────────────────────
// PAYMENT SCREENSHOT
// ─────────────────────────────────────────────

bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft.awaitingScreenshotFor) {
    return ctx.reply("ፎቶ አልጠበቅሁም። ለማዘዝ /menu ይጫኑ።");
  }

  const orderId = draft.awaitingScreenshotFor;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  await pool.query(
    `UPDATE orders SET payment_screenshot_file_id = $1, status = 'payment_submitted' WHERE id = $2`,
    [fileId, orderId]
  );

  await ctx.reply(
    `እናመሰግናለን! የክፍያ ስክሪንሾትዎ ለትዕዛዝ #${orderId} ደርሷል። ${runtimeSettings.name} በቅርቡ ያረጋግጥልዎታል። 🙏`
  );

  const orderResult = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderResult.rows[0];
  const itemsResult = await pool.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
  const items = itemsResult.rows;
  const itemLines = items
    .map((i: any) => `• ${i.item_name} x${i.quantity} — ${i.item_price * i.quantity} ብር`)
    .join("\n");

  const orderTypeLine =
    order.order_type === "delivery"
      ? `🚗 ዴሊቨሪ አድራሻ: ${order.delivery_address}`
      : `🏪 እራሱ ይወስዳል — ${runtimeSettings.address}`;

  const adminText =
    `🆕 አዲስ ትዕዛዝ #${order.id} — ክፍያ ተልኳል\n\n` +
    `👤 ${order.customer_name}\n📞 ${order.customer_phone}\n${orderTypeLine}\n\n` +
    `${itemLines}\n\nድምር: ${order.total_amount} ብር\n\n` +
    `💬 ለደንበኛው ለመልስ: /reply ${order.id} <መልዕክት>`;

  for (const adminId of adminIdsCache) {
    try {
      await bot.telegram.sendPhoto(adminId, fileId, { caption: adminText });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }

  clearDraft(userId);
  remindedUsers.delete(userId);
});

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

initDb()
  .then(ensureSettingsTables)
  .then(loadAdmins)
  .then(loadSettings)
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => {
    console.log(`${runtimeSettings.name} bot is running.`);
    scheduleDailyReset();
    scheduleNightlyReport();
  })
  .catch((err) => console.error("Startup error:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
