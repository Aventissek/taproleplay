const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const SESSION_COOKIE = "tap_session";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/login") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/callback") {
        return await handleCallback(request, env);
      }

      if (url.pathname === "/me") {
        return await handleMe(request, env);
      }

      if (url.pathname === "/logout") {
        return logoutResponse();
      }

      if (url.pathname === "/admin") {
        return await handleAdminPage(request, env);
      }

      if (url.pathname === "/api/admin/user") {
        return await handleAdminUser(request, env);
      }

      if (url.pathname === "/api/admin/balance") {
        return await handleAdminBalance(request, env);
      }

      if (url.pathname === "/api/admin/products") {
        return await handleAdminProducts(request, env);
      }

      if (url.pathname === "/api/admin/product") {
        return await handleAdminProduct(request, env);
      }

      if (url.pathname === "/api/products") {
        return await handlePublicProducts(env);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", {
        status: 404
      });
    } catch (error) {
      console.error(error);

      return new Response(
        "Internal Server Error\n\n" +
        String(error?.message || error),
        {
          status: 500,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8"
          }
        }
      );
    }
  }
};

/* =========================================================
   DISCORD LOGIN
========================================================= */

function handleLogin(request, env) {
  const url = new URL(request.url);
  const redirectUri = new URL(
    "/callback",
    url.origin
  ).toString();

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify"
  });

  return Response.redirect(
    DISCORD_AUTHORIZE + "?" + params.toString(),
    302
  );
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Brak kodu OAuth.", {
      status: 400
    });
  }

  const redirectUri = new URL(
    "/callback",
    url.origin
  ).toString();

  const tokenResponse = await fetch(
    DISCORD_API + "/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
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
    console.error(
      "Discord token error:",
      await tokenResponse.text()
    );

    return new Response(
      "Nie udało się zalogować przez Discord.",
      {
        status: 500
      }
    );
  }

  const tokenData = await tokenResponse.json();

  const userResponse = await fetch(
    DISCORD_API + "/users/@me",
    {
      headers: {
        Authorization:
          "Bearer " + tokenData.access_token
      }
    }
  );

  if (!userResponse.ok) {
    return new Response(
      "Nie udało się pobrać danych Discord.",
      {
        status: 500
      }
    );
  }

  const discordUser = await userResponse.json();

  await env.DB.prepare(
    `
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
    `
  )
    .bind(
      discordUser.id,
      discordUser.username
    )
    .run();

  const sessionPayload = {
    discord_id: discordUser.id,
    username: discordUser.username
  };

  const session = await createSession(
    sessionPayload,
    env.SESSION_SECRET
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        SESSION_COOKIE +
        "=" +
        encodeURIComponent(session) +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800"
    }
  });
}

async function handleMe(request, env) {
  const session = await getSession(request, env);

  if (!session) {
    return jsonResponse({
      loggedIn: false
    });
  }

  const user = await env.DB.prepare(
    `
    SELECT
      discord_id,
      username,
      balance
    FROM users
    WHERE discord_id = ?
    `
  )
    .bind(session.discord_id)
    .first();

  if (!user) {
    return jsonResponse({
      loggedIn: false
    });
  }

  return jsonResponse({
    loggedIn: true,
    discord_id: user.discord_id,
    username: user.username,
    balance: user.balance,
    isAdmin:
      String(user.discord_id) ===
      String(env.ADMIN_DISCORD_ID)
  });
}

function logoutResponse() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        SESSION_COOKIE +
        "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

/* =========================================================
   ADMIN AUTH
========================================================= */

async function requireAdmin(request, env) {
  const session = await getSession(
    request,
    env
  );

  if (!session) {
    return null;
  }

  if (
    String(session.discord_id) !==
    String(env.ADMIN_DISCORD_ID)
  ) {
    return null;
  }

  return session;
}

async function handleAdminPage(request, env) {
  const admin = await requireAdmin(
    request,
    env
  );

  if (!admin) {
    return new Response(
      "Brak dostępu.",
      {
        status: 403,
        headers: {
          "Content-Type":
            "text/plain; charset=UTF-8"
        }
      }
    );
  }

  return new Response(
    adminPage(),
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

/* =========================================================
   ADMIN - USER
========================================================= */

async function handleAdminUser(request, env) {
  const admin = await requireAdmin(
    request,
    env
  );

  if (!admin) {
    return jsonResponse(
      {
        error: "Brak dostępu."
      },
      403
    );
  }

  const url = new URL(request.url);
  const discordId =
    url.searchParams.get("id");

  if (!discordId) {
    return jsonResponse(
      {
        error: "Podaj Discord ID."
      },
      400
    );
  }

  const user = await env.DB.prepare(
    `
    SELECT
      discord_id,
      username,
      balance,
      created_at,
      updated_at
    FROM users
    WHERE discord_id = ?
    `
  )
    .bind(discordId)
    .first();

  if (!user) {
    return jsonResponse(
      {
        error: "Nie znaleziono gracza."
      },
      404
    );
  }

  const transactions =
    await env.DB.prepare(
      `
      SELECT
        id,
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
      `
    )
      .bind(discordId)
      .all();

  return jsonResponse({
    user,
    transactions:
      transactions.results || []
  });
}

/* =========================================================
   ADMIN - BALANCE
========================================================= */

async function handleAdminBalance(
  request,
  env
) {
  const admin = await requireAdmin(
    request,
    env
  );

  if (!admin) {
    return jsonResponse(
      {
        error: "Brak dostępu."
      },
      403
    );
  }

  if (request.method !== "POST") {
    return jsonResponse(
      {
        error: "Metoda niedozwolona."
      },
      405
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: "Nieprawidłowy JSON."
      },
      400
    );
  }

  const discordId =
    String(
      body.discord_id || ""
    ).trim();

  const action =
    String(
      body.action || ""
    ).trim();

  const amount =
    Number(body.amount);

  if (!/^\d{5,25}$/.test(discordId)) {
    return jsonResponse(
      {
        error:
          "Nieprawidłowe Discord ID."
      },
      400
    );
  }

  if (
    action !== "add" &&
    action !== "remove"
  ) {
    return jsonResponse(
      {
        error:
          "Nieprawidłowa operacja."
      },
      400
    );
  }

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return jsonResponse(
      {
        error:
          "Kwota musi być liczbą całkowitą od 1 do 1000000."
      },
      400
    );
  }

  const user = await env.DB.prepare(
    `
    SELECT
      discord_id,
      username,
      balance
    FROM users
    WHERE discord_id = ?
    `
  )
    .bind(discordId)
    .first();

  if (!user) {
    return jsonResponse(
      {
        error:
          "Nie znaleziono gracza."
      },
      404
    );
  }

  const balanceBefore =
    Number(user.balance);

  let balanceAfter;

  if (action === "add") {
    balanceAfter =
      balanceBefore + amount;
  } else {
    balanceAfter =
      balanceBefore - amount;

    if (balanceAfter < 0) {
      return jsonResponse(
        {
          error:
            "Saldo nie może być ujemne."
        },
        400
      );
    }
  }

  const transactionType =
    action === "add"
      ? "add"
      : "remove";

  await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE users
      SET
        balance = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_id = ?
      `
    ).bind(
      balanceAfter,
      discordId
    ),

    env.DB.prepare(
      `
      INSERT INTO transactions (
        discord_id,
        type,
        amount,
        balance_before,
        balance_after,
        admin_discord_id
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `
    ).bind(
      discordId,
      transactionType,
      amount,
      balanceBefore,
      balanceAfter,
      admin.discord_id
    )
  ]);

  const updatedUser =
    await env.DB.prepare(
      `
      SELECT
        discord_id,
        username,
        balance,
        created_at,
        updated_at
      FROM users
      WHERE discord_id = ?
      `
    )
      .bind(discordId)
      .first();

  const transactions =
    await env.DB.prepare(
      `
      SELECT
        id,
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
      `
    )
      .bind(discordId)
      .all();

  return jsonResponse({
    user: updatedUser,
    transactions:
      transactions.results || []
  });
}

/* =========================================================
   ADMIN - PRODUCTS
========================================================= */

async function handleAdminProducts(
  request,
  env
) {
  const admin = await requireAdmin(
    request,
    env
  );

  if (!admin) {
    return jsonResponse(
      {
        error: "Brak dostępu."
      },
      403
    );
  }

  const products =
    await env.DB.prepare(
      `
      SELECT
        id,
        name,
        description,
        price,
        image_url,
        product_type,
        delivery_data,
        is_hit,
        is_active,
        sort_order,
        created_at,
        updated_at
      FROM products
      ORDER BY
        sort_order ASC,
        id DESC
      `
    ).all();

  return jsonResponse({
    products:
      products.results || []
  });
}

async function handleAdminProduct(
  request,
  env
) {
  const admin = await requireAdmin(
    request,
    env
  );

  if (!admin) {
    return jsonResponse(
      {
        error: "Brak dostępu."
      },
      403
    );
  }

  if (
    request.method !== "POST" &&
    request.method !== "PUT" &&
    request.method !== "DELETE"
  ) {
    return jsonResponse(
      {
        error: "Metoda niedozwolona."
      },
      405
    );
  }

  if (request.method === "DELETE") {
    return await deleteProduct(
      request,
      env
    );
  }

  return await saveProduct(
    request,
    env
  );
}

async function saveProduct(
  request,
  env
) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error:
          "Nieprawidłowy JSON."
      },
      400
    );
  }

  const id =
    body.id === null ||
    body.id === undefined ||
    body.id === ""
      ? null
      : Number(body.id);

  const name =
    String(body.name || "")
      .trim();

  const description =
    String(
      body.description || ""
    ).trim();

  const imageUrl =
    String(
      body.image_url || ""
    ).trim();

  const productType =
    String(
      body.product_type || "other"
    ).trim();

  const deliveryData =
    String(
      body.delivery_data || ""
    ).trim();

  const price =
    Number(body.price);

  const sortOrder =
    Number(body.sort_order);

  const isHit =
    body.is_hit ? 1 : 0;

  const isActive =
    body.is_active === false
      ? 0
      : body.is_active === 0
        ? 0
        : 1;

  if (!name) {
    return jsonResponse(
      {
        error:
          "Nazwa produktu jest wymagana."
      },
      400
    );
  }

  if (
    !Number.isInteger(price) ||
    price < 0 ||
    price > 1000000
  ) {
    return jsonResponse(
      {
        error:
          "Cena musi być liczbą całkowitą od 0 do 1000000."
      },
      400
    );
  }

  if (
    !Number.isInteger(sortOrder) ||
    sortOrder < 0 ||
    sortOrder > 1000000
  ) {
    return jsonResponse(
      {
        error:
          "Kolejność musi być liczbą całkowitą od 0 do 1000000."
      },
      400
    );
  }

  if (id !== null) {
    const existing =
      await env.DB.prepare(
        `
        SELECT id
        FROM products
        WHERE id = ?
        `
      )
        .bind(id)
        .first();

    if (!existing) {
      return jsonResponse(
        {
          error:
            "Produkt nie istnieje."
        },
        404
      );
    }

    await env.DB.prepare(
      `
      UPDATE products
      SET
        name = ?,
        description = ?,
        price = ?,
        image_url = ?,
        product_type = ?,
        delivery_data = ?,
        is_hit = ?,
        is_active = ?,
        sort_order = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
      .bind(
        name,
        description,
        price,
        imageUrl,
        productType,
        deliveryData,
        isHit,
        isActive,
        sortOrder,
        id
      )
      .run();

    return jsonResponse({
      success: true,
      message:
        "Produkt został zaktualizowany."
    });
  }

  const result =
    await env.DB.prepare(
      `
      INSERT INTO products (
        name,
        description,
        price,
        image_url,
        product_type,
        delivery_data,
        is_hit,
        is_active,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        name,
        description,
        price,
        imageUrl,
        productType,
        deliveryData,
        isHit,
        isActive,
        sortOrder
      )
      .run();

  return jsonResponse({
    success: true,
    id: result.meta.last_row_id,
    message:
      "Produkt został dodany."
  });
}

async function deleteProduct(
  request,
  env
) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error:
          "Nieprawidłowy JSON."
      },
      400
    );
  }

  const id = Number(body.id);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return jsonResponse(
      {
        error:
          "Nieprawidłowe ID produktu."
      },
      400
    );
  }

  const existing =
    await env.DB.prepare(
      `
      SELECT id
      FROM products
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!existing) {
    return jsonResponse(
      {
        error:
          "Produkt nie istnieje."
      },
      404
    );
  }

  await env.DB.prepare(
    `
    DELETE FROM products
    WHERE id = ?
    `
  )
    .bind(id)
    .run();

  return jsonResponse({
    success: true,
    message:
      "Produkt został usunięty."
  });
}

/* =========================================================
   PUBLIC PRODUCTS API
========================================================= */

async function handlePublicProducts(env) {
  const products =
    await env.DB.prepare(
      `
      SELECT
        id,
        name,
        description,
        price,
        image_url,
        product_type,
        is_hit,
        sort_order
      FROM products
      WHERE is_active = 1
      ORDER BY
        sort_order ASC,
        id DESC
      `
    ).all();

  return jsonResponse({
    products:
      products.results || []
  });
}

/* =========================================================
   SESSION
========================================================= */

function getCookie(
  request,
  name
) {
  const cookieHeader =
    request.headers.get(
      "Cookie"
    );

  if (!cookieHeader) {
    return null;
  }

  const cookies =
    cookieHeader.split(";");

  for (
    const cookie of cookies
  ) {
    const trimmed =
      cookie.trim();

    if (
      trimmed.startsWith(
        name + "="
      )
    ) {
      return decodeURIComponent(
        trimmed.substring(
          name.length + 1
        )
      );
    }
  }

  return null;
}

async function getSession(
  request,
  env
) {
  const raw =
    getCookie(
      request,
      SESSION_COOKIE
    );

  if (!raw) {
    return null;
  }

  const parts =
    raw.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payloadBase64 =
    parts[0];

  const signature =
    parts[1];

  const expectedSignature =
    await hmacSign(
      payloadBase64,
      env.SESSION_SECRET
    );

  if (
    !timingSafeEqual(
      signature,
      expectedSignature
    )
  ) {
    return null;
  }

  try {
    const json =
      base64UrlDecode(
        payloadBase64
      );

    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function createSession(
  payload,
  secret
) {
  const json =
    JSON.stringify(payload);

  const payloadBase64 =
    base64UrlEncode(json);

  const signature =
    await hmacSign(
      payloadBase64,
      secret
    );

  return (
    payloadBase64 +
    "." +
    signature
  );
}

async function hmacSign(
  value,
  secret
) {
  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(value)
    );

  return bytesToBase64Url(
    new Uint8Array(
      signature
    )
  );
}

function timingSafeEqual(
  a,
  b
) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}

function base64UrlEncode(
  value
) {
  return bytesToBase64Url(
    new TextEncoder().encode(
      value
    )
  );
}

function base64UrlDecode(
  value
) {
  const binary =
    atob(
      value
        .replace(/\-/g, "+")
        .replace(/_/g, "/") +
      "=".repeat(
        (4 -
          (value.length % 4)) %
          4
      )
    );

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return new TextDecoder().decode(
    bytes
  );
}

function bytesToBase64Url(
  bytes
) {
  let binary = "";

  for (
    const byte of bytes
  ) {
    binary +=
      String.fromCharCode(
        byte
      );
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function jsonResponse(
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

/* =========================================================
   ADMIN PAGE
========================================================= */

function adminPage() {
  return `<!DOCTYPE html>
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
  font-family: Arial, sans-serif;
  background: #0b0b0f;
  color: #fff;
}

header {
  padding: 20px 30px;
  background: #111116;
  border-bottom: 1px solid #292931;

  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  font-size: 24px;
  font-weight: 800;
  color: #ff6a00;
}

.back {
  color: #fff;
  text-decoration: none;
  background: #202027;
  padding: 10px 15px;
  border-radius: 8px;
}

main {
  width: min(1200px, calc(100% - 30px));
  margin: 35px auto;
}

.tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.tab-button {
  background: #1b1b22;
  color: white;
  border: 1px solid #30303a;
  padding: 12px 18px;
  border-radius: 9px;
  cursor: pointer;
  font-weight: 700;
}

.tab-button.active {
  background: #ff6a00;
  border-color: #ff6a00;
}

.tab {
  display: none;
}

.tab.active {
  display: block;
}

.panel {
  background: #121218;
  border: 1px solid #292931;
  border-radius: 14px;
  padding: 22px;
  margin-bottom: 20px;
}

h1,
h2,
h3 {
  margin-top: 0;
}

input,
textarea,
select {
  width: 100%;
  padding: 12px;
  background: #0c0c10;
  color: white;
  border: 1px solid #30303a;
  border-radius: 8px;
  outline: none;
  margin-bottom: 12px;
}

textarea {
  min-height: 100px;
  resize: vertical;
}

button {
  border: 0;
  border-radius: 8px;
  padding: 11px 17px;
  cursor: pointer;
  font-weight: 700;
  color: white;
  background: #ff6a00;
}

button:hover {
  opacity: .9;
}

button.secondary {
  background: #292932;
}

button.danger {
  background: #b52b2b;
}

button.green {
  background: #238b57;
}

.message {
  margin-top: 12px;
  font-weight: 700;
}

.error {
  color: #ff5d5d;
}

.success {
  color: #45d483;
}

.user-info {
  display: none;
  margin-top: 20px;
}

.balance {
  font-size: 32px;
  font-weight: 800;
  color: #ff6a00;
  margin: 12px 0 20px;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.muted {
  color: #8e8e99;
  font-size: 13px;
}

.transaction {
  background: #0d0d12;
  border: 1px solid #292932;
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 10px;
}

.transaction-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.add {
  color: #45d483;
}

.remove {
  color: #ff5d5d;
}

.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.product-card {
  background: #0d0d12;
  border: 1px solid #292932;
  border-radius: 12px;
  overflow: hidden;
}

.product-image {
  width: 100%;
  height: 170px;
  object-fit: cover;
  background: #191920;
  display: block;
}

.product-content {
  padding: 16px;
}

.product-name {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 6px;
}

.product-price {
  color: #ff6a00;
  font-size: 22px;
  font-weight: 800;
  margin: 10px 0;
}

.badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.badge {
  background: #282832;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
}

.badge.hit {
  background: #ff6a00;
}

.badge.off {
  background: #5a2424;
}

.product-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 15px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
}

.form-full {
  grid-column: 1 / -1;
}

.check-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 15px;
}

.check-row input {
  width: auto;
  margin: 0;
}

.modal {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.75);
  padding: 20px;
  overflow-y: auto;
  z-index: 1000;
}

.modal.open {
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-box {
  width: min(800px, 100%);
  background: #121218;
  border: 1px solid #30303a;
  border-radius: 14px;
  padding: 22px;
}

.modal-buttons {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 15px;
}

@media (max-width: 700px) {
  .actions,
  .form-grid {
    grid-template-columns: 1fr;
  }

  .form-full {
    grid-column: auto;
  }

  header {
    gap: 15px;
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
</head>

<body>

<header>
  <div class="logo">
    TAP ROLEPLAY — ADMIN
  </div>

  <a class="back" href="/">
    ← Sklep
  </a>
</header>

<main>

  <div class="tabs">

    <button
      class="tab-button active"
      data-tab="players"
    >
      👤 Gracze
    </button>

    <button
      class="tab-button"
      data-tab="products"
    >
      🛒 Oferta sklepu
    </button>

  </div>

  <!-- GRACZE -->

  <section
    id="players"
    class="tab active"
  >

    <div class="panel">

      <h1>Zarządzanie graczem</h1>

      <input
        id="discordId"
        type="text"
        placeholder="Discord ID gracza"
      >

      <button id="searchButton">
        Szukaj gracza
      </button>

      <div
        id="message"
        class="message"
      ></div>

      <div
        id="userInfo"
        class="user-info"
      >

        <h2 id="username"></h2>

        <div
          class="muted"
          id="playerDiscordId"
        ></div>

        <div
          id="balance"
          class="balance"
        >
          0 PLN
        </div>

        <input
          id="amount"
          type="number"
          min="1"
          step="1"
          placeholder="Kwota"
        >

        <div class="actions">

          <button
            id="addButton"
          >
            + Dodaj środki
          </button>

          <button
            id="removeButton"
            class="danger"
          >
            − Odejmij środki
          </button>

        </div>

        <div style="margin-top:25px">

          <h2>
            Historia transakcji
          </h2>

          <div id="history"></div>

        </div>

      </div>

    </div>

  </section>

  <!-- PRODUKTY -->

  <section
    id="products"
    class="tab"
  >

    <div class="panel">

      <div style="
        display:flex;
        justify-content:space-between;
        gap:15px;
        align-items:center;
        flex-wrap:wrap;
      ">

        <div>
          <h1>Oferta sklepu</h1>

          <div class="muted">
            Zarządzaj produktami widocznymi w sklepie.
          </div>
        </div>

        <button id="addProductButton">
          + Dodaj produkt
        </button>

      </div>

      <div
        id="productMessage"
        class="message"
      ></div>

    </div>

    <div
      id="productsList"
      class="product-grid"
    ></div>

  </section>

</main>

<!-- MODAL PRODUKTU -->

<div
  id="productModal"
  class="modal"
>

  <div class="modal-box">

    <h2 id="modalTitle">
      Dodaj produkt
    </h2>

    <input
      id="productId"
      type="hidden"
    >

    <div class="form-grid">

      <div>
        <label>Nazwa produktu</label>

        <input
          id="productName"
          type="text"
          placeholder="np. TAP VIP"
        >
      </div>

      <div>
        <label>Cena</label>

        <input
          id="productPrice"
          type="number"
          min="0"
          step="1"
          placeholder="30"
        >
      </div>

      <div class="form-full">

        <label>Opis</label>

        <textarea
          id="productDescription"
          placeholder="Opis produktu..."
        ></textarea>

      </div>

      <div class="form-full">

        <label>Zdjęcie produktu — URL</label>

        <input
          id="productImage"
          type="url"
          placeholder="https://..."
        >

      </div>

      <div>

        <label>Typ produktu</label>

        <select id="productType">

          <option value="money">
            Pieniądze
          </option>

          <option value="vehicle">
            Pojazd
          </option>

          <option value="vip">
            VIP
          </option>

          <option value="pack">
            Pakiet
          </option>

          <option value="other">
            Inne
          </option>

        </select>

      </div>

      <div>

        <label>Kolejność</label>

        <input
          id="productOrder"
          type="number"
          min="0"
          step="1"
          value="0"
        >

      </div>

      <div class="form-full">

        <label>
          Dane dostawy FiveM
        </label>

        <input
          id="productDelivery"
          type="text"
          placeholder="np. vip, vehicle_pack_1, money_100000"
        >

        <div class="muted">
          Tego pola później użyjemy do automatycznej realizacji zakupu w FiveM.
        </div>

      </div>

      <div class="form-full">

        <label class="check-row">

          <input
            id="productHit"
            type="checkbox"
          >

          <span>
            ⭐ Pokaż jako HIT na stronie głównej
          </span>

        </label>

        <label class="check-row">

          <input
            id="productActive"
            type="checkbox"
            checked
          >

          <span>
            Produkt aktywny
          </span>

        </label>

      </div>

    </div>

    <div class="modal-buttons">

      <button
        id="cancelProductButton"
        class="secondary"
      >
        Anuluj
      </button>

      <button
        id="saveProductButton"
      >
        Zapisz produkt
      </button>

    </div>

  </div>

</div>

<script>

(function () {

  /* ==============================
     TABS
  ============================== */

  var tabButtons =
    document.querySelectorAll(
      ".tab-button"
    );

  tabButtons.forEach(
    function (button) {

      button.addEventListener(
        "click",
        function () {

          tabButtons.forEach(
            function (item) {
              item.classList.remove(
                "active"
              );
            }
          );

          document
            .querySelectorAll(".tab")
            .forEach(
              function (tab) {
                tab.classList.remove(
                  "active"
                );
              }
            );

          button.classList.add(
            "active"
          );

          document
            .getElementById(
              button.dataset.tab
            )
            .classList.add(
              "active"
            );

          if (
            button.dataset.tab ===
            "products"
          ) {
            loadProducts();
          }

        }
      );

    }
  );

  /* ==============================
     HELPERS
  ============================== */

  function escapeHtml(value) {

    return String(
      value == null
        ? ""
        : value
    )
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  }

  function showMessage(
    element,
    text,
    type
  ) {

    element.className =
      "message " +
      (type || "");

    element.textContent =
      text || "";

  }

  /* ==============================
     PLAYERS
  ============================== */

  var discordIdInput =
    document.getElementById(
      "discordId"
    );

  var searchButton =
    document.getElementById(
      "searchButton"
    );

  var message =
    document.getElementById(
      "message"
    );

  var userInfo =
    document.getElementById(
      "userInfo"
    );

  var username =
    document.getElementById(
      "username"
    );

  var playerDiscordId =
    document.getElementById(
      "playerDiscordId"
    );

  var balance =
    document.getElementById(
      "balance"
    );

  var amountInput =
    document.getElementById(
      "amount"
    );

  var addButton =
    document.getElementById(
      "addButton"
    );

  var removeButton =
    document.getElementById(
      "removeButton"
    );

  var history =
    document.getElementById(
      "history"
    );

  function renderUser(data) {

    var user =
      data.user;

    userInfo.style.display =
      "block";

    username.textContent =
      user.username;

    playerDiscordId.textContent =
      "Discord ID: " +
      user.discord_id;

    balance.textContent =
      Number(
        user.balance
      ).toLocaleString(
        "pl-PL"
      ) +
      " PLN";

    renderHistory(
      data.transactions || []
    );

  }

  function renderHistory(
    transactions
  ) {

    if (
      !transactions.length
    ) {

      history.innerHTML =
        '<div class="muted">Brak transakcji.</div>';

      return;
    }

    var html = "";

    transactions.forEach(
      function (transaction) {

        var isAdd =
          transaction.type ===
          "add";

        html +=
          '<div class="transaction">' +

          '<div class="transaction-top">' +

          '<strong class="' +
          (isAdd
            ? "add"
            : "remove") +
          '">' +

          (isAdd
            ? "DODANIE"
            : "ODJĘCIE") +

          "</strong>" +

          '<strong class="' +
          (isAdd
            ? "add"
            : "remove") +
          '">' +

          (isAdd
            ? "+"
            : "-") +

          Number(
            transaction.amount
          ).toLocaleString(
            "pl-PL"
          ) +

          " PLN</strong>" +

          "</div>" +

          '<div class="muted">' +

          "Saldo: " +

          Number(
            transaction.balance_before
          ).toLocaleString(
            "pl-PL"
          ) +

          " PLN → " +

          Number(
            transaction.balance_after
          ).toLocaleString(
            "pl-PL"
          ) +

          " PLN</div>" +

          '<div class="muted">' +

          "Administrator: " +

          escapeHtml(
            transaction.admin_discord_id
          ) +

          "</div>" +

          '<div class="muted">' +

          escapeHtml(
            transaction.created_at
          ) +

          "</div>" +

          "</div>";

      }
    );

    history.innerHTML =
      html;

  }

  async function searchUser() {

    var discordId =
      discordIdInput.value.trim();

    if (
      !/^\\d{5,25}$/.test(
        discordId
      )
    ) {

      showMessage(
        message,
        "Podaj prawidłowe Discord ID.",
        "error"
      );

      return;
    }

    showMessage(
      message,
      "Szukanie...",
      ""
    );

    userInfo.style.display =
      "none";

    try {

      var response =
        await fetch(
          "/api/admin/user?id=" +
          encodeURIComponent(
            discordId
          )
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Nie udało się pobrać gracza."
        );
      }

      showMessage(
        message,
        "",
        ""
      );

      renderUser(data);

    } catch (error) {

      showMessage(
        message,
        error.message,
        "error"
      );

    }

  }

  async function changeBalance(
    action
  ) {

    var discordId =
      discordIdInput.value.trim();

    var amount =
      Number(
        amountInput.value
      );

    if (
      !/^\\d{5,25}$/.test(
        discordId
      )
    ) {

      showMessage(
        message,
        "Podaj prawidłowe Discord ID.",
        "error"
      );

      return;
    }

    if (
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > 1000000
    ) {

      showMessage(
        message,
        "Kwota musi być liczbą całkowitą od 1 do 1000000.",
        "error"
      );

      return;
    }

    showMessage(
      message,
      "Zapisywanie...",
      ""
    );

    try {

      var response =
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
                action:
                  action,
                amount:
                  amount
              })
          }
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Nie udało się zmienić salda."
        );
      }

      amountInput.value =
        "";

      showMessage(
        message,
        "Saldo zostało zmienione.",
        "success"
      );

      renderUser(data);

    } catch (error) {

      showMessage(
        message,
        error.message,
        "error"
      );

    }

  }

  searchButton.addEventListener(
    "click",
    searchUser
  );

  discordIdInput.addEventListener(
    "keydown",
    function (event) {

      if (
        event.key === "Enter"
      ) {
        searchUser();
      }

    }
  );

  addButton.addEventListener(
    "click",
    function () {
      changeBalance("add");
    }
  );

  removeButton.addEventListener(
    "click",
    function () {
      changeBalance("remove");
    }
  );

  /* ==============================
     PRODUCTS
  ============================== */

  var productsList =
    document.getElementById(
      "productsList"
    );

  var productMessage =
    document.getElementById(
      "productMessage"
    );

  var productModal =
    document.getElementById(
      "productModal"
    );

  var modalTitle =
    document.getElementById(
      "modalTitle"
    );

  var productId =
    document.getElementById(
      "productId"
    );

  var productName =
    document.getElementById(
      "productName"
    );

  var productDescription =
    document.getElementById(
      "productDescription"
    );

  var productPrice =
    document.getElementById(
      "productPrice"
    );

  var productImage =
    document.getElementById(
      "productImage"
    );

  var productType =
    document.getElementById(
      "productType"
    );

  var productDelivery =
    document.getElementById(
      "productDelivery"
    );

  var productOrder =
    document.getElementById(
      "productOrder"
    );

  var productHit =
    document.getElementById(
      "productHit"
    );

  var productActive =
    document.getElementById(
      "productActive"
    );

  var addProductButton =
    document.getElementById(
      "addProductButton"
    );

  var saveProductButton =
    document.getElementById(
      "saveProductButton"
    );

  var cancelProductButton =
    document.getElementById(
      "cancelProductButton"
    );

  function resetProductForm() {

    productId.value =
      "";

    productName.value =
      "";

    productDescription.value =
      "";

    productPrice.value =
      "";

    productImage.value =
      "";

    productType.value =
      "other";

    productDelivery.value =
      "";

    productOrder.value =
      "0";

    productHit.checked =
      false;

    productActive.checked =
      true;

    modalTitle.textContent =
      "Dodaj produkt";

  }

  function openProductModal(
    product
  ) {

    if (!product) {

      resetProductForm();

    } else {

      productId.value =
        product.id;

      productName.value =
        product.name || "";

      productDescription.value =
        product.description || "";

      productPrice.value =
        product.price;

      productImage.value =
        product.image_url || "";

      productType.value =
        product.product_type ||
        "other";

      productDelivery.value =
        product.delivery_data ||
        "";

      productOrder.value =
        product.sort_order || 0;

      productHit.checked =
        Number(
          product.is_hit
        ) === 1;

      productActive.checked =
        Number(
          product.is_active
        ) === 1;

      modalTitle.textContent =
        "Edytuj produkt";

    }

    productModal.classList.add(
      "open"
    );

  }

  function closeProductModal() {

    productModal.classList.remove(
      "open"
    );

  }

  function productCard(
    product
  ) {

    var image =
      product.image_url
        ? '<img class="product-image" src="' +
          escapeHtml(
            product.image_url
          ) +
          '" alt="' +
          escapeHtml(
            product.name
          ) +
          '">'
        : '<div class="product-image"></div>';

    var badges =
      "";

    if (
      Number(
        product.is_hit
      ) === 1
    ) {

      badges +=
        '<span class="badge hit">⭐ HIT</span>';

    }

    if (
      Number(
        product.is_active
      ) === 1
    ) {

      badges +=
        '<span class="badge">AKTYWNY</span>';

    } else {

      badges +=
        '<span class="badge off">UKRYTY</span>';

    }

    return (
      '<div class="product-card">' +

      image +

      '<div class="product-content">' +

      '<div class="product-name">' +
      escapeHtml(
        product.name
      ) +
      "</div>" +

      '<div class="muted">' +
      escapeHtml(
        product.description
      ) +
      "</div>" +

      '<div class="product-price">' +
      Number(
        product.price
      ).toLocaleString(
        "pl-PL"
      ) +
      " PLN</div>" +

      '<div class="badges">' +
      badges +
      "</div>" +

      '<div class="muted">' +
      "Typ: " +
      escapeHtml(
        product.product_type
      ) +
      "</div>" +

      '<div class="muted">' +
      "Kolejność: " +
      Number(
        product.sort_order
      ) +
      "</div>" +

      '<div class="product-buttons">' +

      '<button data-edit="' +
      product.id +
      '">' +
      "Edytuj" +
      "</button>" +

      '<button class="danger" data-delete="' +
      product.id +
      '">' +
      "Usuń" +
      "</button>" +

      "</div>" +

      "</div>" +

      "</div>"
    );

  }

  async function loadProducts() {

    try {

      var response =
        await fetch(
          "/api/admin/products"
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Nie udało się pobrać produktów."
        );
      }

      var products =
        data.products || [];

      if (!products.length) {

        productsList.innerHTML =
          '<div class="panel">' +
          '<div class="muted">' +
          "Brak produktów. Dodaj pierwszy produkt." +
          "</div>" +
          "</div>";

        return;
      }

      productsList.innerHTML =
        products
          .map(
            productCard
          )
          .join("");

      productsList
        .querySelectorAll(
          "[data-edit]"
        )
        .forEach(
          function (button) {

            button.addEventListener(
              "click",
              function () {

                var id =
                  Number(
                    button.dataset.edit
                  );

                var product =
                  products.find(
                    function (item) {
                      return Number(
                        item.id
                      ) === id;
                    }
                  );

                openProductModal(
                  product
                );

              }
            );

          }
        );

      productsList
        .querySelectorAll(
          "[data-delete]"
        )
        .forEach(
          function (button) {

            button.addEventListener(
              "click",
              async function () {

                var id =
                  Number(
                    button.dataset.delete
                  );

                var confirmed =
                  confirm(
                    "Czy na pewno chcesz usunąć ten produkt?"
                  );

                if (!confirmed) {
                  return;
                }

                await deleteProduct(
                  id
                );

              }
            );

          }
        );

    } catch (error) {

      showMessage(
        productMessage,
        error.message,
        "error"
      );

    }

  }

  async function deleteProduct(
    id
  ) {

    try {

      var response =
        await fetch(
          "/api/admin/product",
          {
            method: "DELETE",
            headers: {
              "Content-Type":
                "application/json"
            },
            body:
              JSON.stringify({
                id: id
              })
          }
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Nie udało się usunąć produktu."
        );
      }

      showMessage(
        productMessage,
        "Produkt został usunięty.",
        "success"
      );

      await loadProducts();

    } catch (error) {

      showMessage(
        productMessage,
        error.message,
        "error"
      );

    }

  }

  async function saveProduct() {

    var name =
      productName.value.trim();

    var description =
      productDescription.value.trim();

    var price =
      Number(
        productPrice.value
      );

    var imageUrl =
      productImage.value.trim();

    var type =
      productType.value;

    var delivery =
      productDelivery.value.trim();

    var order =
      Number(
        productOrder.value
      );

    if (!name) {

      showMessage(
        productMessage,
        "Podaj nazwę produktu.",
        "error"
      );

      return;
    }

    if (
      !Number.isInteger(price) ||
      price < 0
    ) {

      showMessage(
        productMessage,
        "Cena musi być poprawną liczbą całkowitą.",
        "error"
      );

      return;
    }

    if (
      !Number.isInteger(order) ||
      order < 0
    ) {

      showMessage(
        productMessage,
        "Kolejność musi być liczbą całkowitą.",
        "error"
      );

      return;
    }

    saveProductButton.disabled =
      true;

    try {

      var response =
        await fetch(
          "/api/admin/product",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body:
              JSON.stringify({
                id:
                  productId.value
                    ? Number(
                        productId.value
                      )
                    : null,

                name:
                  name,

                description:
                  description,

                price:
                  price,

                image_url:
                  imageUrl,

                product_type:
                  type,

                delivery_data:
                  delivery,

                is_hit:
                  productHit.checked,

                is_active:
                  productActive.checked,

                sort_order:
                  order
              })
          }
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Nie udało się zapisać produktu."
        );
      }

      closeProductModal();

      showMessage(
        productMessage,
        data.message ||
          "Produkt zapisany.",
        "success"
      );

      await loadProducts();

    } catch (error) {

      showMessage(
        productMessage,
        error.message,
        "error"
      );

    } finally {

      saveProductButton.disabled =
        false;

    }

  }

  addProductButton.addEventListener(
    "click",
    function () {
      openProductModal(
        null
      );
    }
  );

  cancelProductButton.addEventListener(
    "click",
    closeProductModal
  );

  saveProductButton.addEventListener(
    "click",
    saveProduct
  );

  productModal.addEventListener(
    "click",
    function (event) {

      if (
        event.target ===
        productModal
      ) {
        closeProductModal();
      }

    }
  );

  loadProducts();

})();

</script>

</body>
</html>`;
}
