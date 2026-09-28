const DISCORD_API = "https://discord.com/api/v10";

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);

      const url = new URL(request.url);

      // =========================
      // PUBLIC
      // =========================

      if (url.pathname === "/login") {
        return login(env);
      }

      if (url.pathname === "/callback") {
        return callback(request, env);
      }

      if (url.pathname === "/logout") {
        return logout();
      }

      if (url.pathname === "/me") {
        return me(request, env);
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return getProducts(env);
      }

      if (url.pathname === "/api/purchase" && request.method === "POST") {
        return purchase(request, env);
      }

      // =========================
      // ADMIN PAGE
      // =========================

      if (url.pathname === "/admin") {
        const session = await getSession(request, env);

        if (!session) {
          return Response.redirect(new URL("/login", request.url), 302);
        }

        if (session.discord_id !== env.ADMIN_DISCORD_ID) {
          return new Response("Brak dostępu.", {
            status: 403,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          });
        }

        return new Response(adminPage(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      // =========================
      // ADMIN API
      // =========================

      if (url.pathname === "/api/admin/user" && request.method === "GET") {
        return adminUser(request, env);
      }

      if (url.pathname === "/api/admin/balance" && request.method === "POST") {
        return adminBalance(request, env);
      }

      if (url.pathname === "/api/admin/transactions" && request.method === "GET") {
        return adminTransactions(request, env);
      }

      if (url.pathname === "/api/admin/products" && request.method === "GET") {
        return adminProducts(env);
      }

      if (url.pathname === "/api/admin/products" && request.method === "POST") {
        return adminCreateProduct(request, env);
      }

      if (url.pathname === "/api/admin/products" && request.method === "PUT") {
        return adminUpdateProduct(request, env);
      }

      if (url.pathname === "/api/admin/products" && request.method === "DELETE") {
        return adminDeleteProduct(request, env);
      }

      return new Response("Not Found", {
        status: 404
      });

    } catch (error) {
      console.error(error);

      return json({
        error: "Wewnętrzny błąd serwera."
      }, 500);
    }
  }
};


// ============================================================
// DATABASE
// ============================================================

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_before INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        admin_discord_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_transactions_discord_id
      ON transactions(discord_id)
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'standard',
        duration_days INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        featured INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        amount INTEGER NOT NULL,
        uid INTEGER,
        status TEXT NOT NULL,
        request_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_request_id
      ON purchases(request_id)
    `)
  ]);

  const count = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM products")
    .first();

  if (!count || Number(count.count) === 0) {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO products
        (name, description, price, type, duration_days, active, featured, sort_order)
        VALUES (?, ?, ?, ?, ?, 1, 1, 1)
      `).bind(
        "Unban 1 dzień",
        "Unban na 1 dzień.",
        10,
        "unban",
        1
      ),

      env.DB.prepare(`
        INSERT INTO products
        (name, description, price, type, duration_days, active, featured, sort_order)
        VALUES (?, ?, ?, ?, ?, 1, 0, 2)
      `).bind(
        "Unban 2 dni",
        "Unban na 2 dni.",
        20,
        "unban",
        2
      ),

      env.DB.prepare(`
        INSERT INTO products
        (name, description, price, type, duration_days, active, featured, sort_order)
        VALUES (?, ?, ?, ?, ?, 1, 0, 3)
      `).bind(
        "Unban 3 dni",
        "Unban na 3 dni.",
        30,
        "unban",
        3
      )
    ]);
  }
}


// ============================================================
// DISCORD LOGIN
// ============================================================

function login(env) {
  const clientId = env.DISCORD_CLIENT_ID;

  const redirectUri =
    "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback";

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "identify"
  });

  return Response.redirect(
    "https://discord.com/oauth2/authorize?" + params.toString(),
    302
  );
}


async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Brak kodu OAuth.", {
      status: 400
    });
  }

  const redirectUri =
    "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback";

  const tokenResponse = await fetch(
    "https://discord.com/api/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    }
  );

  if (!tokenResponse.ok) {
    return new Response("Nie udało się zalogować przez Discord.", {
      status: 400
    });
  }

  const tokenData = await tokenResponse.json();

  const userResponse = await fetch(
    `${DISCORD_API}/users/@me`,
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    }
  );

  if (!userResponse.ok) {
    return new Response("Nie udało się pobrać użytkownika Discord.", {
      status: 400
    });
  }

  const discordUser = await userResponse.json();

  const username =
    discordUser.global_name ||
    discordUser.username ||
    "Użytkownik";

  await env.DB.prepare(`
    INSERT INTO users
      (discord_id, username, balance)
    VALUES (?, ?, 0)
    ON CONFLICT(discord_id)
    DO UPDATE SET
      username = excluded.username,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    discordUser.id,
    username
  ).run();

  const session = {
    discord_id: discordUser.id,
    username
  };

  const cookie = await createSessionCookie(session, env);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": cookie
    }
  });
}


function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "tap_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    }
  });
}


// ============================================================
// SESSION
// ============================================================

async function createSessionCookie(data, env) {
  const payload = btoa(
    JSON.stringify({
      ...data,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    })
  );

  const signature = await hmacSign(
    payload,
    env.SESSION_SECRET
  );

  return `tap_session=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}


async function getSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";

  const match = cookieHeader.match(
    /(?:^|;\s*)tap_session=([^;]+)/
  );

  if (!match) {
    return null;
  }

  const value = match[1];
  const parts = value.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payload = parts[0];
  const signature = parts[1];

  const expected = await hmacSign(
    payload,
    env.SESSION_SECRET
  );

  if (signature !== expected) {
    return null;
  }

  try {
    const data = JSON.parse(
      atob(payload)
    );

    if (!data.exp || Date.now() > data.exp) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}


async function hmacSign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}


// ============================================================
// /ME
// ============================================================

async function me(request, env) {
  const session = await getSession(request, env);

  if (!session) {
    return json({
      loggedIn: false
    });
  }

  const user = await env.DB.prepare(`
    SELECT discord_id, username, balance
    FROM users
    WHERE discord_id = ?
  `).bind(
    session.discord_id
  ).first();

  if (!user) {
    return json({
      loggedIn: false
    });
  }

  return json({
    loggedIn: true,
    discord_id: user.discord_id,
    username: user.username,
    balance: user.balance,
    isAdmin:
      user.discord_id === env.ADMIN_DISCORD_ID
  });
}


// ============================================================
// PRODUCTS
// ============================================================

async function getProducts(env) {
  const result = await env.DB.prepare(`
    SELECT
      id,
      name,
      description,
      price,
      type,
      duration_days,
      featured
    FROM products
    WHERE active = 1
    ORDER BY sort_order ASC, id ASC
  `).all();

  return json(result.results || []);
}


// ============================================================
// PURCHASE
// ============================================================

async function purchase(request, env) {
  const session = await getSession(request, env);

  if (!session) {
    return json({
      error: "Musisz być zalogowany."
    }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "Nieprawidłowe dane."
    }, 400);
  }

  const productId = Number(body.product_id);
  const uid = Number(body.uid);

  if (!Number.isInteger(productId) || productId <= 0) {
    return json({
      error: "Nieprawidłowy produkt."
    }, 400);
  }

  if (!Number.isInteger(uid) || uid <= 0) {
    return json({
      error: "Nieprawidłowy UID."
    }, 400);
  }

  const product = await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE id = ?
      AND active = 1
  `).bind(
    productId
  ).first();

  if (!product) {
    return json({
      error: "Produkt nie istnieje."
    }, 404);
  }

  if (product.type !== "unban") {
    return json({
      error: "Ten produkt nie jest jeszcze dostępny."
    }, 400);
  }

  const price = Number(product.price);

  const user = await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE discord_id = ?
  `).bind(
    session.discord_id
  ).first();

  if (!user) {
    return json({
      error: "Nie znaleziono konta."
    }, 404);
  }

  const balanceBefore = Number(user.balance);

  if (balanceBefore < price) {
    return json({
      error: "Masz za mało środków."
    }, 400);
  }

  // Unikalny numer zakupu.
  const requestId =
    crypto.randomUUID();

  // ========================================================
  // 1. ZAPISUJEMY ZAKUP JAKO PENDING
  // ========================================================

  await env.DB.prepare(`
    INSERT INTO purchases
    (
      discord_id,
      product_id,
      product_name,
      amount,
      uid,
      status,
      request_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    session.discord_id,
    product.id,
    product.name,
    price,
    uid,
    "pending",
    requestId
  ).run();

  // ========================================================
  // 2. BOT DISCORD WYSYŁA:
  //
  //    .unban UID
  //
  // ========================================================

  let discordResult;

  try {
    discordResult = await sendUnbanCommandToDiscord(
      env,
      uid
    );
  } catch (error) {
    console.error(error);

    await env.DB.prepare(`
      UPDATE purchases
      SET
        status = 'failed',
        error_message = ?
      WHERE request_id = ?
    `).bind(
      "Nie udało się wysłać komendy Discord.",
      requestId
    ).run();

    return json({
      error: "Nie udało się wysłać komendy unban. Saldo nie zostało pobrane."
    }, 500);
  }

  if (!discordResult.success) {
    await env.DB.prepare(`
      UPDATE purchases
      SET
        status = 'failed',
        error_message = ?
      WHERE request_id = ?
    `).bind(
      discordResult.error || "Discord API error",
      requestId
    ).run();

    return json({
      error:
        "Bot Discord nie mógł wysłać komendy. Saldo nie zostało pobrane."
    }, 500);
  }

  // ========================================================
  // 3. DOPIERO TERAZ ODEJMUJEMY ŚRODKI
  // ========================================================

  const balanceAfter =
    balanceBefore - price;

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET
        balance = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_id = ?
    `).bind(
      balanceAfter,
      session.discord_id
    ),

    env.DB.prepare(`
      INSERT INTO transactions
      (
        discord_id,
        type,
        amount,
        balance_before,
        balance_after,
        admin_discord_id
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      session.discord_id,
      "purchase",
      -price,
      balanceBefore,
      balanceAfter,
      null
    ),

    env.DB.prepare(`
      UPDATE purchases
      SET status = 'success'
      WHERE request_id = ?
    `).bind(
      requestId
    )
  ]);

  return json({
    success: true,
    balance: balanceAfter,
    uid,
    product: product.name
  });
}


// ============================================================
// DISCORD BOT -> SEND .unban UID
// ============================================================

async function sendUnbanCommandToDiscord(env, uid) {
  if (!env.DISCORD_BOT_TOKEN) {
    return {
      success: false,
      error: "Brak DISCORD_BOT_TOKEN."
    };
  }

  if (!env.DISCORD_SHOP_CHANNEL_ID) {
    return {
      success: false,
      error: "Brak DISCORD_SHOP_CHANNEL_ID."
    };
  }

  const message = `.unban ${uid}`;

  const response = await fetch(
    `${DISCORD_API}/channels/${env.DISCORD_SHOP_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: message
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();

    console.error(
      "Discord API error:",
      response.status,
      text
    );

    return {
      success: false,
      error: `Discord API ${response.status}`
    };
  }

  return {
    success: true
  };
}


// ============================================================
// ADMIN AUTH
// ============================================================

async function requireAdmin(request, env) {
  const session = await getSession(request, env);

  if (!session) {
    return null;
  }

  if (session.discord_id !== env.ADMIN_DISCORD_ID) {
    return null;
  }

  return session;
}


// ============================================================
// ADMIN USER
// ============================================================

async function adminUser(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return json({
      error: "Brak Discord ID."
    }, 400);
  }

  const user = await env.DB.prepare(`
    SELECT
      discord_id,
      username,
      balance,
      created_at,
      updated_at
    FROM users
    WHERE discord_id = ?
  `).bind(id).first();

  if (!user) {
    return json({
      error: "Nie znaleziono użytkownika."
    }, 404);
  }

  return json(user);
}


// ============================================================
// ADMIN BALANCE
// ============================================================

async function adminBalance(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "Nieprawidłowe dane."
    }, 400);
  }

  const discordId = String(body.discord_id || "");
  const type = String(body.type || "");
  const amount = Number(body.amount);

  if (!discordId) {
    return json({
      error: "Brak Discord ID."
    }, 400);
  }

  if (!["add", "remove"].includes(type)) {
    return json({
      error: "Nieprawidłowy typ operacji."
    }, 400);
  }

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return json({
      error: "Nieprawidłowa kwota."
    }, 400);
  }

  const user = await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE discord_id = ?
  `).bind(discordId).first();

  if (!user) {
    return json({
      error: "Nie znaleziono użytkownika."
    }, 404);
  }

  const before = Number(user.balance);

  let after;

  if (type === "add") {
    after = before + amount;
  } else {
    after = before - amount;
  }

  if (after < 0) {
    return json({
      error: "Saldo nie może być ujemne."
    }, 400);
  }

  const transactionAmount =
    type === "add"
      ? amount
      : -amount;

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users
      SET
        balance = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_id = ?
    `).bind(
      after,
      discordId
    ),

    env.DB.prepare(`
      INSERT INTO transactions
      (
        discord_id,
        type,
        amount,
        balance_before,
        balance_after,
        admin_discord_id
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      discordId,
      type === "add"
        ? "admin_add"
        : "admin_remove",
      transactionAmount,
      before,
      after,
      admin.discord_id
    )
  ]);

  return json({
    success: true,
    balance: after
  });
}


// ============================================================
// ADMIN TRANSACTIONS
// ============================================================

async function adminTransactions(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  const url = new URL(request.url);
  const discordId = url.searchParams.get("id");

  if (!discordId) {
    return json({
      error: "Brak Discord ID."
    }, 400);
  }

  const result = await env.DB.prepare(`
    SELECT
      id,
      discord_id,
      type,
      amount,
      balance_before,
      balance_after,
      admin_discord_id,
      created_at
    FROM transactions
    WHERE discord_id = ?
    ORDER BY id DESC
    LIMIT 100
  `).bind(discordId).all();

  return json(result.results || []);
}


// ============================================================
// ADMIN PRODUCTS
// ============================================================

async function adminProducts(env) {
  const result = await env.DB.prepare(`
    SELECT *
    FROM products
    ORDER BY sort_order ASC, id ASC
  `).all();

  return json(result.results || []);
}


async function adminCreateProduct(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "Nieprawidłowe dane."
    }, 400);
  }

  const name = String(body.name || "").trim();
  const description = String(body.description || "");
  const price = Number(body.price);
  const type = String(body.type || "standard");
  const durationDays =
    body.duration_days == null
      ? null
      : Number(body.duration_days);

  const active =
    body.active === false
      ? 0
      : 1;

  const featured =
    body.featured === true
      ? 1
      : 0;

  const sortOrder =
    Number.isInteger(Number(body.sort_order))
      ? Number(body.sort_order)
      : 0;

  if (!name) {
    return json({
      error: "Nazwa produktu jest wymagana."
    }, 400);
  }

  if (
    !Number.isInteger(price) ||
    price < 0 ||
    price > 1000000
  ) {
    return json({
      error: "Nieprawidłowa cena."
    }, 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO products
    (
      name,
      description,
      price,
      type,
      duration_days,
      active,
      featured,
      sort_order
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    name,
    description,
    price,
    type,
    durationDays,
    active,
    featured,
    sortOrder
  ).run();

  return json({
    success: true,
    id: result.meta.last_row_id
  });
}


async function adminUpdateProduct(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "Nieprawidłowe dane."
    }, 400);
  }

  const id = Number(body.id);

  if (!Number.isInteger(id) || id <= 0) {
    return json({
      error: "Nieprawidłowe ID produktu."
    }, 400);
  }

  const existing = await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE id = ?
  `).bind(id).first();

  if (!existing) {
    return json({
      error: "Produkt nie istnieje."
    }, 404);
  }

  const name =
    body.name !== undefined
      ? String(body.name).trim()
      : existing.name;

  const description =
    body.description !== undefined
      ? String(body.description)
      : existing.description;

  const price =
    body.price !== undefined
      ? Number(body.price)
      : Number(existing.price);

  const type =
    body.type !== undefined
      ? String(body.type)
      : existing.type;

  const durationDays =
    body.duration_days !== undefined
      ? (
          body.duration_days === null
            ? null
            : Number(body.duration_days)
        )
      : existing.duration_days;

  const active =
    body.active !== undefined
      ? (body.active ? 1 : 0)
      : existing.active;

  const featured =
    body.featured !== undefined
      ? (body.featured ? 1 : 0)
      : existing.featured;

  const sortOrder =
    body.sort_order !== undefined
      ? Number(body.sort_order)
      : existing.sort_order;

  if (!name) {
    return json({
      error: "Nazwa produktu jest wymagana."
    }, 400);
  }

  if (
    !Number.isInteger(price) ||
    price < 0 ||
    price > 1000000
  ) {
    return json({
      error: "Nieprawidłowa cena."
    }, 400);
  }

  await env.DB.prepare(`
    UPDATE products
    SET
      name = ?,
      description = ?,
      price = ?,
      type = ?,
      duration_days = ?,
      active = ?,
      featured = ?,
      sort_order = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    name,
    description,
    price,
    type,
    durationDays,
    active,
    featured,
    sortOrder,
    id
  ).run();

  return json({
    success: true
  });
}


async function adminDeleteProduct(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return json({
      error: "Brak dostępu."
    }, 403);
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));

  if (!Number.isInteger(id) || id <= 0) {
    return json({
      error: "Nieprawidłowe ID produktu."
    }, 400);
  }

  await env.DB.prepare(`
    UPDATE products
    SET
      active = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(id).run();

  return json({
    success: true
  });
}


// ============================================================
// ADMIN PAGE
// ============================================================

function adminPage() {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TAP Roleplay — Admin</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #0b0b0f;
  color: white;
  font-family: Arial, sans-serif;
}

header {
  padding: 22px 7%;
  background: #111116;
  border-bottom: 1px solid #25252d;
}

.logo {
  color: #ff6a00;
  font-weight: 900;
  font-size: 24px;
}

main {
  max-width: 1100px;
  margin: 40px auto;
  padding: 20px;
}

.card {
  background: #121218;
  border: 1px solid #292932;
  border-radius: 12px;
  padding: 25px;
  margin-bottom: 25px;
}

h1 {
  margin-top: 0;
}

input,
select {
  width: 100%;
  padding: 11px;
  margin: 6px 0;
  border-radius: 7px;
  border: 1px solid #333;
  background: #0b0b0f;
  color: white;
}

button {
  border: 0;
  border-radius: 7px;
  padding: 11px 16px;
  background: #ff6a00;
  color: white;
  font-weight: bold;
  cursor: pointer;
  margin: 4px;
}

button:hover {
  background: #ff7b1a;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 20px;
}

th,
td {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid #292932;
}

.small {
  color: #999;
  font-size: 13px;
}
</style>
</head>

<body>

<header>
  <div class="logo">TAP ROLEPLAY — ADMIN</div>
</header>

<main>

<div class="card">
  <h1>Gracz</h1>

  <input
    id="discordId"
    placeholder="Discord ID gracza"
  >

  <button onclick="loadUser()">
    Szukaj gracza
  </button>

  <div id="user"></div>
</div>


<div class="card">
  <h1>Produkty</h1>

  <div id="products">
    Ładowanie...
  </div>
</div>

</main>

<script>

async function loadUser() {
  const id =
    document.getElementById("discordId").value.trim();

  if (!id) {
    alert("Podaj Discord ID.");
    return;
  }

  const response =
    await fetch(
      "/api/admin/user?id=" +
      encodeURIComponent(id)
    );

  const data =
    await response.json();

  if (!response.ok) {
    alert(data.error || "Błąd.");
    return;
  }

  document.getElementById("user").innerHTML =

    "<p><strong>" +
    escapeHtml(data.username) +
    "</strong></p>" +

    "<p class='small'>" +
    escapeHtml(data.discord_id) +
    "</p>" +

    "<h2>Saldo: " +
    Number(data.balance) +
    " PLN</h2>" +

    "<input id='amount' type='number' min='1' placeholder='Kwota'>" +

    "<button onclick='changeBalance(\"add\")'>" +
    "Dodaj" +
    "</button>" +

    "<button onclick='changeBalance(\"remove\")'>" +
    "Usuń" +
    "</button>" +

    "<div id='transactions'></div>";

  loadTransactions(id);
}


async function changeBalance(type) {
  const discordId =
    document.getElementById("discordId").value.trim();

  const amount =
    Number(document.getElementById("amount").value);

  if (!amount || amount <= 0) {
    alert("Podaj kwotę.");
    return;
  }

  const response =
    await fetch("/api/admin/balance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        discord_id: discordId,
        type,
        amount
      })
    });

  const data =
    await response.json();

  if (!response.ok) {
    alert(data.error || "Błąd.");
    return;
  }

  document.getElementById("amount").value = "";

  loadUser();
}


async function loadTransactions(id) {
  const response =
    await fetch(
      "/api/admin/transactions?id=" +
      encodeURIComponent(id)
    );

  const data =
    await response.json();

  if (!response.ok) {
    return;
  }

  let html =
    "<h3>Historia</h3>" +
    "<table>" +
    "<tr>" +
    "<th>Typ</th>" +
    "<th>Kwota</th>" +
    "<th>Przed</th>" +
    "<th>Po</th>" +
    "<th>Data</th>" +
    "</tr>";

  for (const row of data) {
    html +=
      "<tr>" +
      "<td>" + escapeHtml(row.type) + "</td>" +
      "<td>" + Number(row.amount) + "</td>" +
      "<td>" + Number(row.balance_before) + "</td>" +
      "<td>" + Number(row.balance_after) + "</td>" +
      "<td>" + escapeHtml(row.created_at) + "</td>" +
      "</tr>";
  }

  html += "</table>";

  document.getElementById("transactions").innerHTML =
    html;
}


async function loadProducts() {
  const response =
    await fetch("/api/admin/products");

  const products =
    await response.json();

  if (!response.ok) {
    document.getElementById("products").textContent =
      products.error || "Błąd.";
    return;
  }

  let html = "";

  for (const product of products) {
    html +=
      "<div class='card'>" +

      "<h3>" +
      escapeHtml(product.name) +
      "</h3>" +

      "<p>" +
      escapeHtml(product.description || "") +
      "</p>" +

      "<p>Cena: <strong>" +
      Number(product.price) +
      " PLN</strong></p>" +

      "<p>Typ: " +
      escapeHtml(product.type) +
      "</p>" +

      "<p>Dni: " +
      (product.duration_days ?? "-") +
      "</p>" +

      "<p>Aktywny: " +
      (product.active ? "TAK" : "NIE") +
      "</p>" +

      "<button onclick='toggleProduct(" +
      Number(product.id) +
      "," +
      (product.active ? "false" : "true") +
      ")'>" +

      (product.active
        ? "Wyłącz"
        : "Włącz") +

      "</button>" +

      "</div>";
  }

  document.getElementById("products").innerHTML =
    html;
}


async function toggleProduct(id, active) {
  const response =
    await fetch("/api/admin/products", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id,
        active
      })
    });

  const data =
    await response.json();

  if (!response.ok) {
    alert(data.error || "Błąd.");
    return;
  }

  loadProducts();
}


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadProducts();

</script>

</body>
</html>`;
}


// ============================================================
// JSON
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
