const COOKIE_NAME = "tap_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // =========================
      // STATIC FILES
      // =========================

      // Strona główna i wszystkie statyczne pliki
      if (
        request.method === "GET" &&
        !url.pathname.startsWith("/api/") &&
        ![
          "/login",
          "/callback",
          "/logout",
          "/me",
          "/admin"
        ].includes(url.pathname)
      ) {
        return env.ASSETS.fetch(request);
      }

      // =========================
      // LOGIN
      // =========================

      if (url.pathname === "/login") {
        const discordUrl = new URL(
          "https://discord.com/oauth2/authorize"
        );

        discordUrl.searchParams.set(
          "client_id",
          env.DISCORD_CLIENT_ID
        );

        discordUrl.searchParams.set(
          "response_type",
          "code"
        );

        discordUrl.searchParams.set(
          "redirect_uri",
          `${url.origin}/callback`
        );

        discordUrl.searchParams.set(
          "scope",
          "identify"
        );

        return Response.redirect(
          discordUrl.toString(),
          302
        );
      }

      // =========================
      // CALLBACK
      // =========================

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");

        if (!code) {
          return new Response(
            "Brak kodu OAuth.",
            { status: 400 }
          );
        }

        const tokenResponse = await fetch(
          "https://discord.com/api/oauth2/token",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              client_id: env.DISCORD_CLIENT_ID,
              client_secret:
                env.DISCORD_CLIENT_SECRET,
              grant_type: "authorization_code",
              code,
              redirect_uri:
                `${url.origin}/callback`
            })
          }
        );

        if (!tokenResponse.ok) {
          const errorText =
            await tokenResponse.text();

          console.error(
            "Discord OAuth token error:",
            errorText
          );

          return new Response(
            "Nie udało się zalogować przez Discord.",
            { status: 500 }
          );
        }

        const token =
          await tokenResponse.json();

        const userResponse = await fetch(
          "https://discord.com/api/users/@me",
          {
            headers: {
              Authorization:
                `Bearer ${token.access_token}`
            }
          }
        );

        if (!userResponse.ok) {
          return new Response(
            "Nie udało się pobrać danych Discord.",
            { status: 500 }
          );
        }

        const discordUser =
          await userResponse.json();

        // D1 jest potrzebne dopiero tutaj
        await ensureSchema(env);

        await env.DB.prepare(`
          INSERT INTO users (
            discord_id,
            username,
            balance
          )
          VALUES (?, ?, 0)
          ON CONFLICT(discord_id)
          DO UPDATE SET
            username = excluded.username,
            updated_at = CURRENT_TIMESTAMP
        `)
          .bind(
            discordUser.id,
            getDiscordUsername(discordUser)
          )
          .run();

        const sessionId =
          crypto.randomUUID();

        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            discord_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `).run();

        await env.DB.prepare(`
          INSERT INTO sessions (
            id,
            discord_id,
            expires_at
          )
          VALUES (?, ?, ?)
        `)
          .bind(
            sessionId,
            discordUser.id,
            Date.now() + SESSION_MAX_AGE * 1000
          )
          .run();

        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie":
              `${COOKIE_NAME}=${sessionId}; ` +
              `Path=/; HttpOnly; Secure; SameSite=Lax; ` +
              `Max-Age=${SESSION_MAX_AGE}`
          }
        });
      }

      // =========================
      // LOGOUT
      // =========================

      if (url.pathname === "/logout") {
        const sessionId =
          getCookie(request, COOKIE_NAME);

        if (sessionId) {
          try {
            await env.DB.prepare(`
              DELETE FROM sessions
              WHERE id = ?
            `)
              .bind(sessionId)
              .run();
          } catch (e) {
            console.error(
              "Logout DB error:",
              e
            );
          }
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie":
              `${COOKIE_NAME}=; ` +
              `Path=/; HttpOnly; Secure; SameSite=Lax; ` +
              `Max-Age=0`
          }
        });
      }

      // =========================
      // CURRENT USER
      // =========================

      if (url.pathname === "/me") {
        await ensureSchema(env);

        const user =
          await getCurrentUser(
            request,
            env
          );

        if (!user) {
          return json({
            loggedIn: false
          });
        }

        return json({
          loggedIn: true,
          id: user.discord_id,
          username: user.username,
          balance: user.balance,
          isAdmin:
            user.discord_id ===
            env.ADMIN_DISCORD_ID
        });
      }

      // =========================
      // PRODUCTS
      // =========================

      if (
        url.pathname === "/api/products" &&
        request.method === "GET"
      ) {
        await ensureSchema(env);

        const result =
          await env.DB.prepare(`
            SELECT
              id,
              name,
              description,
              price,
              type,
              duration_days,
              active,
              featured,
              sort_order
            FROM products
            WHERE active = 1
            ORDER BY
              featured DESC,
              sort_order ASC,
              id ASC
          `).all();

        return json({
          products:
            result.results || []
        });
      }

      // =========================
      // PURCHASE
      // =========================

      if (
        url.pathname === "/api/purchase" &&
        request.method === "POST"
      ) {
        await ensureSchema(env);

        const user =
          await getCurrentUser(
            request,
            env
          );

        if (!user) {
          return json(
            {
              error:
                "Musisz być zalogowany."
            },
            401
          );
        }

        let body;

        try {
          body =
            await request.json();
        } catch {
          return json(
            {
              error:
                "Nieprawidłowe dane."
            },
            400
          );
        }

        const productId =
          Number(body.product_id);

        const uid =
          body.uid !== undefined &&
          body.uid !== null &&
          String(body.uid).trim() !== ""
            ? Number(body.uid)
            : null;

        if (
          !Number.isInteger(productId) ||
          productId <= 0
        ) {
          return json(
            {
              error:
                "Nieprawidłowy produkt."
            },
            400
          );
        }

        const product =
          await env.DB.prepare(`
            SELECT *
            FROM products
            WHERE id = ?
              AND active = 1
            LIMIT 1
          `)
            .bind(productId)
            .first();

        if (!product) {
          return json(
            {
              error:
                "Produkt nie istnieje."
            },
            404
          );
        }

        if (
          product.type === "unban"
        ) {
          if (
            !Number.isInteger(uid) ||
            uid <= 0
          ) {
            return json(
              {
                error:
                  "Podaj prawidłowy UID gracza."
              },
              400
            );
          }
        }

        if (
          Number(user.balance) <
          Number(product.price)
        ) {
          return json(
            {
              error:
                "Nie masz wystarczającej liczby PLN."
            },
            400
          );
        }

        const requestId =
          crypto.randomUUID();

        // ---------------------------------
        // UNBAN
        // ---------------------------------

        if (
          product.type === "unban"
        ) {
          try {
            await sendUnbanCommandToDiscord(
              env,
              uid
            );
          } catch (error) {
            console.error(
              "Discord unban error:",
              error
            );

            await env.DB.prepare(`
              INSERT INTO purchases (
                discord_id,
                product_id,
                product_name,
                amount,
                uid,
                status,
                request_id,
                error_message
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
              .bind(
                user.discord_id,
                product.id,
                product.name,
                product.price,
                uid,
                "failed",
                requestId,
                String(
                  error?.message ||
                  "Discord error"
                ).slice(0, 1000)
              )
              .run();

            return json(
              {
                error:
                  "Nie udało się wysłać komendy unbana. PLN nie zostały pobrane."
              },
              502
            );
          }
        }

        // ---------------------------------
        // DEDUKCJA SALDA
        // ---------------------------------

        const freshUser =
          await env.DB.prepare(`
            SELECT *
            FROM users
            WHERE discord_id = ?
            LIMIT 1
          `)
            .bind(user.discord_id)
            .first();

        if (!freshUser) {
          return json(
            {
              error:
                "Nie znaleziono konta."
            },
            404
          );
        }

        const balanceBefore =
          Number(freshUser.balance);

        const price =
          Number(product.price);

        if (
          balanceBefore < price
        ) {
          return json(
            {
              error:
                "Nie masz wystarczającej liczby PLN."
            },
            400
          );
        }

        const balanceAfter =
          balanceBefore - price;

        await env.DB.prepare(`
          UPDATE users
          SET
            balance = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE discord_id = ?
        `)
          .bind(
            balanceAfter,
            user.discord_id
          )
          .run();

        await env.DB.prepare(`
          INSERT INTO transactions (
            discord_id,
            type,
            amount,
            balance_before,
            balance_after
          )
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(
            user.discord_id,
            "purchase",
            -price,
            balanceBefore,
            balanceAfter
          )
          .run();

        await env.DB.prepare(`
          INSERT INTO purchases (
            discord_id,
            product_id,
            product_name,
            amount,
            uid,
            status,
            request_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            user.discord_id,
            product.id,
            product.name,
            price,
            uid,
            "completed",
            requestId
          )
          .run();

        return json({
          success: true,
          message:
            product.type === "unban"
              ? "Unban został wysłany."
              : "Zakup został wykonany.",
          balance:
            balanceAfter
        });
      }

      // =========================
      // ADMIN CHECK
      // =========================

      if (
        url.pathname.startsWith(
          "/api/admin/"
        )
      ) {
        await ensureSchema(env);

        const user =
          await getCurrentUser(
            request,
            env
          );

        if (!user) {
          return json(
            {
              error:
                "Musisz być zalogowany."
            },
            401
          );
        }

        if (
          user.discord_id !==
          env.ADMIN_DISCORD_ID
        ) {
          return json(
            {
              error:
                "Brak uprawnień."
            },
            403
          );
        }

        return handleAdmin(
          request,
          env,
          url
        );
      }

      // =========================
      // ADMIN PAGE
      // =========================

      if (
        url.pathname === "/admin" &&
        request.method === "GET"
      ) {
        return new Response(
          ADMIN_HTML,
          {
            headers: {
              "Content-Type":
                "text/html; charset=UTF-8"
            }
          }
        );
      }

      // =========================
      // FALLBACK
      // =========================

      return env.ASSETS.fetch(
        request
      );

    } catch (error) {
      console.error(
        "Worker error:",
        error
      );

      return json(
        {
          error:
            "Wewnętrzny błąd serwera."
        },
        500
      );
    }
  }
};


// =====================================================
// DATABASE
// =====================================================

async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
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
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_transactions_discord_id
    ON transactions(discord_id)
  `).run();

  await env.DB.prepare(`
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
  `).run();

  await env.DB.prepare(`
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
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `).run();

  // Sprawdzenie kolumn purchases
  const columns =
    await env.DB
      .prepare(
        `PRAGMA table_info(purchases)`
      )
      .all();

  const names =
    (columns.results || [])
      .map(column => column.name);

  if (!names.includes("request_id")) {
    await env.DB.prepare(`
      ALTER TABLE purchases
      ADD COLUMN request_id TEXT
    `).run();
  }

  if (!names.includes("error_message")) {
    await env.DB.prepare(`
      ALTER TABLE purchases
      ADD COLUMN error_message TEXT
    `).run();
  }

  // Indeks robimy dopiero po upewnieniu się,
  // że kolumna istnieje.
  try {
    await env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_purchases_request_id
      ON purchases(request_id)
    `).run();
  } catch (error) {
    console.error(
      "Purchase index error:",
      error
    );
  }

  // Domyślny produkt
  const count =
    await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM products
      `)
      .first();

  if (
    !count ||
    Number(count.count) === 0
  ) {
    await env.DB.prepare(`
      INSERT INTO products (
        name,
        description,
        price,
        type,
        duration_days,
        active,
        featured,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, 1, 1, 1)
    `)
      .bind(
        "Unban",
        "Odblokowanie gracza. Wpisz UID gracza podczas zakupu.",
        10,
        "unban",
        1
      )
      .run();
  }
}


// =====================================================
// DISCORD
// =====================================================

function getDiscordUsername(user) {
  if (user.global_name) {
    return user.global_name;
  }

  if (user.username) {
    return user.username;
  }

  return "Discord User";
}


async function sendUnbanCommandToDiscord(
  env,
  uid
) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error(
      "Brak DISCORD_BOT_TOKEN"
    );
  }

  if (!env.DISCORD_SHOP_CHANNEL_ID) {
    throw new Error(
      "Brak DISCORD_SHOP_CHANNEL_ID"
    );
  }

  const response =
    await fetch(
      `https://discord.com/api/v10/channels/${env.DISCORD_SHOP_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization":
            `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          content:
            `.unban ${uid}`
        })
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Discord HTTP ${response.status}: ${text}`
    );
  }
}


// =====================================================
// SESSION
// =====================================================

async function getCurrentUser(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      COOKIE_NAME
    );

  if (!sessionId) {
    return null;
  }

  const session =
    await env.DB.prepare(`
      SELECT
        s.discord_id,
        s.expires_at,
        u.username,
        u.balance
      FROM sessions s
      JOIN users u
        ON u.discord_id = s.discord_id
      WHERE s.id = ?
      LIMIT 1
    `)
      .bind(sessionId)
      .first();

  if (!session) {
    return null;
  }

  if (
    Number(session.expires_at) <
    Date.now()
  ) {
    await env.DB.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `)
      .bind(sessionId)
      .run();

    return null;
  }

  return session;
}


function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get("Cookie");

  if (!cookie) {
    return null;
  }

  const parts =
    cookie.split(";");

  for (const part of parts) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part.slice(0, index).trim();

    const value =
      part.slice(index + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}


// =====================================================
// ADMIN
// =====================================================

async function handleAdmin(
  request,
  env,
  url
) {
  // ---------------------------------
  // GET USERS
  // ---------------------------------

  if (
    url.pathname ===
    "/api/admin/users" &&
    request.method === "GET"
  ) {
    const discordId =
      url.searchParams.get(
        "discord_id"
      );

    if (discordId) {
      const user =
        await env.DB.prepare(`
          SELECT *
          FROM users
          WHERE discord_id = ?
          LIMIT 1
        `)
          .bind(discordId)
          .first();

      return json({
        users:
          user ? [user] : []
      });
    }

    const users =
      await env.DB.prepare(`
        SELECT *
        FROM users
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

    return json({
      users:
        users.results || []
    });
  }

  // ---------------------------------
  // ADD BALANCE
  // ---------------------------------

  if (
    url.pathname ===
    "/api/admin/balance" &&
    request.method === "POST"
  ) {
    const body =
      await request.json();

    const discordId =
      String(
        body.discord_id || ""
      ).trim();

    const amount =
      Number(body.amount);

    if (
      !discordId ||
      !Number.isInteger(amount) ||
      amount === 0
    ) {
      return json(
        {
          error:
            "Nieprawidłowe dane."
        },
        400
      );
    }

    const user =
      await env.DB.prepare(`
        SELECT *
        FROM users
        WHERE discord_id = ?
        LIMIT 1
      `)
        .bind(discordId)
        .first();

    if (!user) {
      return json(
        {
          error:
            "Użytkownik nie istnieje."
        },
        404
      );
    }

    const before =
      Number(user.balance);

    const after =
      before + amount;

    if (after < 0) {
      return json(
        {
          error:
            "Saldo nie może być ujemne."
        },
        400
      );
    }

    await env.DB.prepare(`
      UPDATE users
      SET
        balance = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_id = ?
    `)
      .bind(
        after,
        discordId
      )
      .run();

    await env.DB.prepare(`
      INSERT INTO transactions (
        discord_id,
        type,
        amount,
        balance_before,
        balance_after,
        admin_discord_id
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        discordId,
        amount > 0
          ? "admin_add"
          : "admin_remove",
        amount,
        before,
        after,
        env.ADMIN_DISCORD_ID
      )
      .run();

    return json({
      success: true,
      balance: after
    });
  }

  // ---------------------------------
  // TRANSACTIONS
  // ---------------------------------

  if (
    url.pathname ===
    "/api/admin/transactions" &&
    request.method === "GET"
  ) {
    const discordId =
      url.searchParams.get(
        "discord_id"
      );

    let result;

    if (discordId) {
      result =
        await env.DB.prepare(`
          SELECT *
          FROM transactions
          WHERE discord_id = ?
          ORDER BY id DESC
          LIMIT 100
        `)
          .bind(discordId)
          .all();
    } else {
      result =
        await env.DB.prepare(`
          SELECT *
          FROM transactions
          ORDER BY id DESC
          LIMIT 100
        `).all();
    }

    return json({
      transactions:
        result.results || []
    });
  }

  // ---------------------------------
  // PRODUCTS
  // ---------------------------------

  if (
    url.pathname ===
    "/api/admin/products" &&
    request.method === "GET"
  ) {
    const result =
      await env.DB.prepare(`
        SELECT *
        FROM products
        ORDER BY
          sort_order ASC,
          id ASC
      `).all();

    return json({
      products:
        result.results || []
    });
  }

  // ---------------------------------
  // TOGGLE PRODUCT
  // ---------------------------------

  if (
    url.pathname ===
    "/api/admin/products/toggle" &&
    request.method === "POST"
  ) {
    const body =
      await request.json();

    const productId =
      Number(body.product_id);

    if (
      !Number.isInteger(productId)
    ) {
      return json(
        {
          error:
            "Nieprawidłowe ID produktu."
        },
        400
      );
    }

    const product =
      await env.DB.prepare(`
        SELECT *
        FROM products
        WHERE id = ?
        LIMIT 1
      `)
        .bind(productId)
        .first();

    if (!product) {
      return json(
        {
          error:
            "Produkt nie istnieje."
        },
        404
      );
    }

    const newStatus =
      Number(product.active) === 1
        ? 0
        : 1;

    await env.DB.prepare(`
      UPDATE products
      SET
        active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(
        newStatus,
        productId
      )
      .run();

    return json({
      success: true,
      active: newStatus
    });
  }

  return json(
    {
      error:
        "Nie znaleziono endpointu."
    },
    404
  );
}


// =====================================================
// JSON
// =====================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        "Cache-Control":
          "no-store"
      }
    }
  );
}


// =====================================================
// ADMIN HTML
// =====================================================

const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>TAP Roleplay — Admin</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080808;
  color: #fff;
  font-family: Arial, sans-serif;
}

header {
  padding: 22px;
  border-bottom: 1px solid #242424;
  background: #0d0d0d;
}

h1 {
  margin: 0;
  color: #ff6a00;
}

main {
  max-width: 1100px;
  margin: 30px auto;
  padding: 0 20px;
}

.card {
  background: #111;
  border: 1px solid #292929;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

input,
button {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #181818;
  color: white;
}

input {
  width: 100%;
  margin-bottom: 10px;
}

button {
  cursor: pointer;
  background: #ff6a00;
  border-color: #ff6a00;
  color: #fff;
  font-weight: bold;
}

button:hover {
  opacity: .9;
}

table {
  width: 100%;
  border-collapse: collapse;
}

td,
th {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid #292929;
}

.status-on {
  color: #49d17d;
}

.status-off {
  color: #ff5555;
}

.message {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: #181818;
}
</style>
</head>

<body>

<header>
  <h1>TAP Roleplay — Panel Admina</h1>
</header>

<main>

  <div class="card">
    <h2>Saldo gracza</h2>

    <input
      id="discordId"
      placeholder="Discord ID gracza"
    >

    <input
      id="amount"
      type="number"
      placeholder="Kwota, np. 100 lub -50"
    >

    <button onclick="changeBalance()">
      Zmień saldo
    </button>

    <div id="balanceMessage"></div>
  </div>


  <div class="card">
    <h2>Produkty</h2>

    <div id="products">
      Ładowanie...
    </div>
  </div>


  <div class="card">
    <h2>Transakcje</h2>

    <div id="transactions">
      Ładowanie...
    </div>
  </div>

</main>

<script>

async function changeBalance() {
  const discordId =
    document.getElementById("discordId").value.trim();

  const amount =
    Number(
      document.getElementById("amount").value
    );

  const response =
    await fetch("/api/admin/balance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        discord_id: discordId,
        amount
      })
    });

  const data =
    await response.json();

  document.getElementById(
    "balanceMessage"
  ).innerHTML =
    "<div class='message'>" +
    (
      data.error ||
      "Saldo: " + data.balance + " PLN"
    ) +
    "</div>";

  loadTransactions();
}


async function loadProducts() {
  const response =
    await fetch(
      "/api/admin/products"
    );

  const data =
    await response.json();

  const container =
    document.getElementById(
      "products"
    );

  if (!data.products) {
    container.textContent =
      data.error || "Błąd.";
    return;
  }

  container.innerHTML =
    data.products.map(product => {

      const active =
        Number(product.active) === 1;

      return \`
        <div
          style="
            padding:15px;
            border-bottom:1px solid #292929;
          "
        >
          <strong>
            \${escapeHtml(product.name)}
          </strong>

          —
          \${product.price} PLN

          <span
            class="\${active ? "status-on" : "status-off"}"
          >
            \${active ? "AKTYWNY" : "WYŁĄCZONY"}
          </span>

          <button
            style="margin-left:10px"
            onclick="toggleProduct(\${product.id})"
          >
            \${active ? "Wyłącz" : "Włącz"}
          </button>
        </div>
      \`;
    }).join("");
}


async function toggleProduct(id) {
  await fetch(
    "/api/admin/products/toggle",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        product_id: id
      })
    }
  );

  loadProducts();
}


async function loadTransactions() {
  const response =
    await fetch(
      "/api/admin/transactions"
    );

  const data =
    await response.json();

  const container =
    document.getElementById(
      "transactions"
    );

  if (!data.transactions) {
    container.textContent =
      data.error || "Błąd.";
    return;
  }

  container.innerHTML =
    "<table>" +
    "<tr>" +
    "<th>Discord ID</th>" +
    "<th>Typ</th>" +
    "<th>Kwota</th>" +
    "<th>Przed</th>" +
    "<th>Po</th>" +
    "<th>Data</th>" +
    "</tr>" +

    data.transactions.map(t =>
      "<tr>" +
      "<td>" +
      escapeHtml(t.discord_id) +
      "</td>" +

      "<td>" +
      escapeHtml(t.type) +
      "</td>" +

      "<td>" +
      t.amount +
      "</td>" +

      "<td>" +
      t.balance_before +
      "</td>" +

      "<td>" +
      t.balance_after +
      "</td>" +

      "<td>" +
      escapeHtml(t.created_at) +
      "</td>" +

      "</tr>"
    ).join("") +

    "</table>";
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
loadTransactions();

</script>

</body>
</html>
`;
