const COOKIE_NAME = "tap_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return await healthCheck(env);
      }

      if (url.pathname === "/login" && request.method === "GET") {
        if (!env.DISCORD_CLIENT_ID) {
          return textResponse(
            "Brak DISCORD_CLIENT_ID w konfiguracji Cloudflare.",
            500
          );
        }

        const redirectUri = `${url.origin}/callback`;
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
          redirectUri
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

      if (url.pathname === "/callback" && request.method === "GET") {
        return await handleDiscordCallback(
          request,
          env,
          url
        );
      }

      if (url.pathname === "/logout" && request.method === "GET") {
        return await logout(request, env);
      }

      if (url.pathname === "/me" && request.method === "GET") {
        await ensureSchema(env);

        const user = await getCurrentUser(
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
          balance: Number(user.balance),
          isAdmin:
            user.discord_id ===
            String(env.ADMIN_DISCORD_ID || "")
        });
      }

      if (
        url.pathname === "/api/products" &&
        request.method === "GET"
      ) {
        await ensureSchema(env);

        const result = await env.DB.prepare(`
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
          products: result.results || []
        });
      }

      if (
        url.pathname === "/api/purchase" &&
        request.method === "POST"
      ) {
        return await purchaseProduct(
          request,
          env
        );
      }

      if (url.pathname.startsWith("/api/admin/")) {
        await ensureSchema(env);

        const admin = await requireAdmin(
          request,
          env
        );

        if (!admin.ok) {
          return admin.response;
        }

        return await handleAdmin(
          request,
          env,
          url
        );
      }

      if (
        url.pathname === "/admin" &&
        request.method === "GET"
      ) {
        return new Response(
          ADMIN_HTML,
          {
            status: 200,
            headers: {
              "Content-Type":
                "text/html; charset=UTF-8",
              "Cache-Control":
                "no-store"
            }
          }
        );
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(
        "WORKER ERROR:",
        error
      );

      return json(
        {
          error:
            "Wewnętrzny błąd serwera.",
          details:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};


// ==================================================
// DISCORD OAUTH CALLBACK
// ==================================================

async function handleDiscordCallback(
  request,
  env,
  url
) {
  const oauthError =
    url.searchParams.get("error");

  if (oauthError) {
    const description =
      url.searchParams.get(
        "error_description"
      );

    return errorPage(
      "Logowanie przez Discord zostało anulowane.",
      description || oauthError
    );
  }

  const code =
    url.searchParams.get("code");

  if (!code) {
    return errorPage(
      "Brak kodu Discord OAuth.",
      "Discord nie zwrócił parametru code."
    );
  }

  if (!env.DISCORD_CLIENT_ID) {
    return errorPage(
      "Brak konfiguracji Discord.",
      "DISCORD_CLIENT_ID nie jest ustawiony."
    );
  }

  if (!env.DISCORD_CLIENT_SECRET) {
    return errorPage(
      "Brak konfiguracji Discord.",
      "DISCORD_CLIENT_SECRET nie jest ustawiony jako Secret."
    );
  }

  const redirectUri =
    `${url.origin}/callback`;

  const tokenResponse = await fetch(
    "https://discord.com/api/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body:
        new URLSearchParams({
          client_id:
            env.DISCORD_CLIENT_ID,

          client_secret:
            env.DISCORD_CLIENT_SECRET,

          grant_type:
            "authorization_code",

          code,

          redirect_uri:
            redirectUri
        }).toString()
    }
  );

  const tokenText =
    await tokenResponse.text();

  if (!tokenResponse.ok) {
    console.error(
      "DISCORD TOKEN ERROR:",
      tokenResponse.status,
      tokenText
    );

    let details = tokenText;

    try {
      const parsed =
        JSON.parse(tokenText);

      details =
        parsed.error_description ||
        parsed.error ||
        tokenText;
    } catch {}

    return errorPage(
      "Discord odrzucił logowanie.",
      `HTTP ${tokenResponse.status}: ${details}`
    );
  }

  let token;

  try {
    token =
      JSON.parse(tokenText);
  } catch {
    return errorPage(
      "Nieprawidłowa odpowiedź Discorda.",
      "Discord nie zwrócił poprawnego JSON."
    );
  }

  if (!token.access_token) {
    return errorPage(
      "Discord nie zwrócił tokenu.",
      tokenText
    );
  }

  const userResponse = await fetch(
    "https://discord.com/api/users/@me",
    {
      method: "GET",
      headers: {
        "Authorization":
          `Bearer ${token.access_token}`
      }
    }
  );

  const userText =
    await userResponse.text();

  if (!userResponse.ok) {
    console.error(
      "DISCORD USER ERROR:",
      userResponse.status,
      userText
    );

    return errorPage(
      "Nie udało się pobrać konta Discord.",
      `HTTP ${userResponse.status}: ${userText}`
    );
  }

  let discordUser;

  try {
    discordUser =
      JSON.parse(userText);
  } catch {
    return errorPage(
      "Nieprawidłowa odpowiedź Discorda.",
      "Nie udało się odczytać danych użytkownika."
    );
  }

  if (!discordUser.id) {
    return errorPage(
      "Discord nie zwrócił ID użytkownika.",
      userText
    );
  }

  await ensureSchema(env);

  const username =
    getDiscordUsername(
      discordUser
    );

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
      String(discordUser.id),
      username
    )
    .run();

  const sessionId =
    crypto.randomUUID();

  const expiresAt =
    Date.now() +
    SESSION_MAX_AGE * 1000;

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
      String(discordUser.id),
      expiresAt
    )
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/",
      "Set-Cookie":
        `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; ` +
        `Path=/; ` +
        `HttpOnly; ` +
        `Secure; ` +
        `SameSite=Lax; ` +
        `Max-Age=${SESSION_MAX_AGE}`
    }
  });
}


// ==================================================
// LOGOUT
// ==================================================

async function logout(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      COOKIE_NAME
    );

  if (sessionId) {
    try {
      await env.DB.prepare(`
        DELETE FROM sessions
        WHERE id = ?
      `)
        .bind(sessionId)
        .run();
    } catch (error) {
      console.error(
        "LOGOUT ERROR:",
        error
      );
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/",
      "Set-Cookie":
        `${COOKIE_NAME}=; ` +
        `Path=/; ` +
        `HttpOnly; ` +
        `Secure; ` +
        `SameSite=Lax; ` +
        `Max-Age=0`
    }
  });
}


// ==================================================
// DATABASE SCHEMA
// ==================================================

async function ensureSchema(env) {
  if (!env.DB) {
    throw new Error(
      "Brak bindingu DB."
    );
  }

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
    CREATE INDEX IF NOT EXISTS
    idx_transactions_discord_id
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

  // ==========================================
  // PRODUCTS MIGRATION
  // ==========================================

  const productColumns =
    await env.DB.prepare(
      "PRAGMA table_info(products)"
    ).all();

  const productNames =
    (productColumns.results || [])
      .map(
        column =>
          String(column.name)
      );

  if (!productNames.includes("type")) {
    await env.DB.prepare(`
      ALTER TABLE products
      ADD COLUMN type TEXT NOT NULL DEFAULT 'standard'
    `).run();
  }

  if (
    !productNames.includes(
      "duration_days"
    )
  ) {
    await env.DB.prepare(`
      ALTER TABLE products
      ADD COLUMN duration_days INTEGER
    `).run();
  }

  if (!productNames.includes("active")) {
    await env.DB.prepare(`
      ALTER TABLE products
      ADD COLUMN active INTEGER NOT NULL DEFAULT 1
    `).run();
  }

  if (
    !productNames.includes(
      "featured"
    )
  ) {
    await env.DB.prepare(`
      ALTER TABLE products
      ADD COLUMN featured INTEGER NOT NULL DEFAULT 0
    `).run();
  }

  if (
    !productNames.includes(
      "sort_order"
    )
  ) {
    await env.DB.prepare(`
      ALTER TABLE products
      ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
    `).run();
  }

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

  // ==========================================
  // PURCHASES MIGRATION
  // ==========================================

  const purchaseColumns =
    await env.DB.prepare(
      "PRAGMA table_info(purchases)"
    ).all();

  const purchaseNames =
    (purchaseColumns.results || [])
      .map(
        column =>
          String(column.name)
      );

  if (
    !purchaseNames.includes(
      "request_id"
    )
  ) {
    await env.DB.prepare(`
      ALTER TABLE purchases
      ADD COLUMN request_id TEXT
    `).run();
  }

  if (
    !purchaseNames.includes(
      "error_message"
    )
  ) {
    await env.DB.prepare(`
      ALTER TABLE purchases
      ADD COLUMN error_message TEXT
    `).run();
  }

  try {
    await env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_purchases_request_id
      ON purchases(request_id)
    `).run();
  } catch (error) {
    console.error(
      "REQUEST ID INDEX:",
      error
    );
  }

  // ==========================================
  // DEFAULT UNBAN
  // ==========================================

  const productCount =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM products
    `).first();

  if (
    !productCount ||
    Number(productCount.count) === 0
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

  await env.DB.prepare(`
    DELETE FROM sessions
    WHERE expires_at < ?
  `)
    .bind(Date.now())
    .run();
}


// ==================================================
// CURRENT USER
// ==================================================

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
      INNER JOIN users u
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


// ==================================================
// PURCHASE
// ==================================================

async function purchaseProduct(
  request,
  env
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

  let uid = null;

  if (
    product.type === "unban"
  ) {
    uid =
      Number(body.uid);

    if (
      !Number.isInteger(uid) ||
      uid <= 0
    ) {
      return json(
        {
          error:
            "Podaj prawidłowy UID."
        },
        400
      );
    }
  }

  const price =
    Number(product.price);

  if (!Number.isInteger(price)) {
    return json(
      {
        error:
          "Nieprawidłowa cena produktu."
      },
      500
    );
  }

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

  const requestId =
    crypto.randomUUID();

  // ==========================================
  // UNBAN -> BOT
  // ==========================================

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
        "UNBAN DISCORD ERROR:",
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
          price,
          uid,
          "failed",
          requestId,
          String(
            error?.message ||
            error
          ).slice(0, 1000)
        )
        .run();

      return json(
        {
          error:
            "Nie udało się wysłać komendy unbana. Saldo nie zostało pobrane.",
          details:
            String(
              error?.message ||
              error
            )
        },
        502
      );
    }
  }

  // ==========================================
  // DEDUCT BALANCE
  // ==========================================

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

  // ==========================================
  // TRANSACTION
  // ==========================================

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

  // ==========================================
  // PURCHASE
  // ==========================================

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


// ==================================================
// DISCORD BOT
// ==================================================

async function sendUnbanCommandToDiscord(
  env,
  uid
) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error(
      "Brak DISCORD_BOT_TOKEN."
    );
  }

  if (!env.DISCORD_SHOP_CHANNEL_ID) {
    throw new Error(
      "Brak DISCORD_SHOP_CHANNEL_ID."
    );
  }

  const channelId =
    String(
      env.DISCORD_SHOP_CHANNEL_ID
    );

  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
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

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Discord ${response.status}: ${responseText}`
    );
  }
}


// ==================================================
// ADMIN AUTH
// ==================================================

async function requireAdmin(
  request,
  env
) {
  const user =
    await getCurrentUser(
      request,
      env
    );

  if (!user) {
    return {
      ok: false,
      response: json(
        {
          error:
            "Musisz być zalogowany."
        },
        401
      )
    };
  }

  if (
    String(user.discord_id) !==
    String(
      env.ADMIN_DISCORD_ID || ""
    )
  ) {
    return {
      ok: false,
      response: json(
        {
          error:
            "Brak uprawnień administratora."
        },
        403
      )
    };
  }

  return {
    ok: true,
    user
  };
}


// ==================================================
// ADMIN API
// ==================================================

async function handleAdmin(
  request,
  env,
  url
) {
  // USERS
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

    const result =
      await env.DB.prepare(`
        SELECT *
        FROM users
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

    return json({
      users:
        result.results || []
    });
  }

  // BALANCE
  if (
    url.pathname ===
      "/api/admin/balance" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          error:
            "Nieprawidłowe JSON."
        },
        400
      );
    }

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

  // TRANSACTIONS
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

  // PRODUCTS
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

  // TOGGLE PRODUCT
  if (
    url.pathname ===
      "/api/admin/products/toggle" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          error:
            "Nieprawidłowe JSON."
        },
        400
      );
    }

    const productId =
      Number(
        body.product_id
      );

    if (
      !Number.isInteger(
        productId
      )
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

    const active =
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
        active,
        productId
      )
      .run();

    return json({
      success: true,
      active
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


// ==================================================
// HEALTH CHECK
// ==================================================

async function healthCheck(env) {
  const result = {
    worker: true,

    database: false,

    discord_client_id:
      Boolean(
        env.DISCORD_CLIENT_ID
      ),

    discord_client_secret:
      Boolean(
        env.DISCORD_CLIENT_SECRET
      ),

    session_secret:
      Boolean(
        env.SESSION_SECRET
      ),

    discord_bot_token:
      Boolean(
        env.DISCORD_BOT_TOKEN
      ),

    discord_shop_channel:
      Boolean(
        env.DISCORD_SHOP_CHANNEL_ID
      ),

    admin_id:
      Boolean(
        env.ADMIN_DISCORD_ID
      ),

    assets:
      Boolean(
        env.ASSETS
      )
  };

  try {
    if (!env.DB) {
      throw new Error(
        "Brak DB binding."
      );
    }

    await env.DB
      .prepare("SELECT 1")
      .first();

    result.database = true;

  } catch (error) {
    result.database_error =
      error?.message ||
      String(error);
  }

  return json(result);
}


// ==================================================
// COOKIE
// ==================================================

function getCookie(
  request,
  name
) {
  const header =
    request.headers.get(
      "Cookie"
    );

  if (!header) {
    return null;
  }

  for (
    const part of header.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part
        .slice(0, index)
        .trim();

    if (key !== name) {
      continue;
    }

    const value =
      part
        .slice(index + 1)
        .trim();

    try {
      return decodeURIComponent(
        value
      );
    } catch {
      return value;
    }
  }

  return null;
}


// ==================================================
// DISCORD USERNAME
// ==================================================

function getDiscordUsername(
  user
) {
  if (user.global_name) {
    return user.global_name;
  }

  if (user.username) {
    return user.username;
  }

  return "Discord User";
}


// ==================================================
// JSON
// ==================================================

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


// ==================================================
// TEXT
// ==================================================

function textResponse(
  text,
  status = 200
) {
  return new Response(
    text,
    {
      status,
      headers: {
        "Content-Type":
          "text/plain; charset=UTF-8",
        "Cache-Control":
          "no-store"
      }
    }
  );
}


// ==================================================
// ERROR PAGE
// ==================================================

function errorPage(
  title,
  details
) {
  const safeTitle =
    escapeHtml(title);

  const safeDetails =
    escapeHtml(details);

  return new Response(
`
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
TAP Roleplay — Błąd logowania
</title>

<style>

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  background: #080808;
  color: #fff;

  font-family:
    Arial,
    sans-serif;
}

.box {
  width:
    min(
      650px,
      calc(100% - 30px)
    );

  padding: 30px;

  border:
    1px solid #292929;

  border-radius: 15px;

  background: #111;
}

h1 {
  color: #ff6a00;
}

.details {
  padding: 15px;

  background: #080808;

  border-radius: 10px;

  white-space: pre-wrap;

  word-break: break-word;

  color: #ccc;
}

a {
  display: inline-block;

  margin-top: 20px;

  padding: 12px 18px;

  border-radius: 8px;

  background: #ff6a00;

  color: white;

  text-decoration: none;

  font-weight: bold;
}

</style>

</head>

<body>

<div class="box">

<h1>
${safeTitle}
</h1>

<div class="details">
${safeDetails}
</div>

<a href="/">
Wróć na stronę
</a>

</div>

</body>
</html>
`,
    {
      status: 500,

      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


// ==================================================
// ESCAPE HTML
// ==================================================

function escapeHtml(
  value
) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


// ==================================================
// ADMIN HTML
// ==================================================

const ADMIN_HTML = `
<!DOCTYPE html>

<html lang="pl">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
TAP Roleplay — Admin
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background: #080808;

  color: white;

  font-family:
    Arial,
    sans-serif;
}

header {
  padding: 22px;

  background: #0d0d0d;

  border-bottom:
    1px solid #292929;
}

h1 {
  margin: 0;

  color: #ff6a00;
}

main {
  max-width: 1100px;

  margin: 30px auto;

  padding:
    0 20px;
}

.card {
  background: #111;

  border:
    1px solid #292929;

  border-radius: 12px;

  padding: 20px;

  margin-bottom: 20px;
}

input,
button {
  padding: 12px;

  border-radius: 8px;

  border:
    1px solid #333;

  color: white;

  background: #181818;
}

input {
  width: 100%;

  margin-bottom: 10px;
}

button {
  cursor: pointer;

  background: #ff6a00;

  border-color:
    #ff6a00;

  font-weight: bold;
}

button:hover {
  opacity: .9;
}

table {
  width: 100%;

  border-collapse:
    collapse;
}

th,
td {
  padding: 10px;

  text-align: left;

  border-bottom:
    1px solid #292929;
}

.green {
  color: #4bd47d;
}

.red {
  color: #ff5555;
}

.message {
  margin-top: 12px;

  padding: 12px;

  background: #181818;

  border-radius: 8px;
}

</style>

</head>

<body>

<header>

<h1>
TAP Roleplay — Panel Admina
</h1>

</header>

<main>

<div class="card">

<h2>
Saldo gracza
</h2>

<input
  id="discordId"
  placeholder="Discord ID gracza"
/>

<input
  id="amount"
  type="number"
  placeholder="Kwota, np. 100 lub -50"
/>

<button onclick="changeBalance()">
Zmień saldo
</button>

<div id="balanceMessage">
</div>

</div>


<div class="card">

<h2>
Produkty
</h2>

<div id="products">
Ładowanie...
</div>

</div>


<div class="card">

<h2>
Transakcje
</h2>

<div id="transactions">
Ładowanie...
</div>

</div>

</main>


<script>

async function changeBalance() {

  const discordId =
    document
      .getElementById(
        "discordId"
      )
      .value
      .trim();

  const amount =
    Number(
      document
        .getElementById(
          "amount"
        )
        .value
    );

  const response =
    await fetch(
      "/api/admin/balance",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            discord_id:
              discordId,

            amount
          })
      }
    );

  const data =
    await response.json();

  document
    .getElementById(
      "balanceMessage"
    )
    .innerHTML =
      "<div class='message'>" +
      (
        data.error ||
        (
          "Saldo: " +
          data.balance +
          " PLN"
        )
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
      data.error ||
      "Błąd.";

    return;
  }

  container.innerHTML =
    data.products
      .map(
        product => {

          const active =
            Number(
              product.active
            ) === 1;

          return \`
            <div
              style="
                padding:15px;
                border-bottom:
                  1px solid #292929;
              "
            >

              <strong>
                \${escapeHtml(
                  product.name
                )}
              </strong>

              —
              \${product.price} PLN

              <span
                class="\${
                  active
                    ? "green"
                    : "red"
                }"
              >
                \${
                  active
                    ? " AKTYWNY"
                    : " WYŁĄCZONY"
                }
              </span>

              <button
                style="
                  margin-left:10px;
                "
                onclick="
                  toggleProduct(
                    \${product.id}
                  )
                "
              >
                \${
                  active
                    ? "Wyłącz"
                    : "Włącz"
                }
              </button>

            </div>
          \`;
        }
      )
      .join("");
}


async function toggleProduct(
  id
) {

  await fetch(
    "/api/admin/products/toggle",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
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
      data.error ||
      "Błąd.";

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

    data.transactions
      .map(
        t =>

          "<tr>" +

          "<td>" +
          escapeHtml(
            t.discord_id
          ) +
          "</td>" +

          "<td>" +
          escapeHtml(
            t.type
          ) +
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
          escapeHtml(
            t.created_at
          ) +
          "</td>" +

          "</tr>"
      )
      .join("") +

    "</table>";
}


function escapeHtml(
  value
) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


loadProducts();

loadTransactions();

</script>

</body>

</html>
`;
