const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const SESSION_COOKIE = "tap_session";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/login") {
        return handleLogin(env);
      }

      if (url.pathname === "/callback") {
        return await handleCallback(request, env);
      }

      if (url.pathname === "/me") {
        return await handleMe(request, env);
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

      if (url.pathname === "/logout") {
        return logoutResponse();
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

      return new Response(
        "Internal Server Error\n\n" + String(error?.message || error),
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

function handleLogin(env) {
  const redirectUri = new URL("/callback", "https://taproleplay.kosscirzynskikuba-4a4.workers.dev").toString();

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
    return new Response("Brak kodu OAuth.", { status: 400 });
  }

  const redirectUri = new URL("/callback", url.origin).toString();

  const tokenResponse = await fetch(DISCORD_API + "/oauth2/token", {
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
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();

    console.error("Discord token error:", errorText);

    return new Response(
      "Nie udało się zalogować przez Discord.",
      { status: 500 }
    );
  }

  const tokenData = await tokenResponse.json();

  const userResponse = await fetch(DISCORD_API + "/users/@me", {
    headers: {
      Authorization: "Bearer " + tokenData.access_token
    }
  });

  if (!userResponse.ok) {
    return new Response(
      "Nie udało się pobrać danych Discord.",
      { status: 500 }
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
      String(user.discord_id) === String(env.ADMIN_DISCORD_ID)
  });
}

async function handleAdminPage(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return new Response("Brak dostępu.", {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=UTF-8"
      }
    });
  }

  return new Response(adminPage(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8"
    }
  });
}

async function handleAdminUser(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return jsonResponse(
      { error: "Brak dostępu." },
      403
    );
  }

  const url = new URL(request.url);
  const discordId = url.searchParams.get("id");

  if (!discordId) {
    return jsonResponse(
      { error: "Podaj Discord ID." },
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
      { error: "Nie znaleziono gracza." },
      404
    );
  }

  const transactions = await env.DB.prepare(
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
    transactions: transactions.results || []
  });
}

async function handleAdminBalance(request, env) {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return jsonResponse(
      { error: "Brak dostępu." },
      403
    );
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Metoda niedozwolona." },
      405
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "Nieprawidłowy JSON." },
      400
    );
  }

  const discordId = String(body.discord_id || "").trim();
  const action = String(body.action || "").trim();
  const amount = Number(body.amount);

  if (!/^\d{5,25}$/.test(discordId)) {
    return jsonResponse(
      { error: "Nieprawidłowe Discord ID." },
      400
    );
  }

  if (action !== "add" && action !== "remove") {
    return jsonResponse(
      { error: "Nieprawidłowa operacja." },
      400
    );
  }

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return jsonResponse(
      { error: "Kwota musi być liczbą całkowitą od 1 do 1000000." },
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
      { error: "Nie znaleziono gracza." },
      404
    );
  }

  const balanceBefore = Number(user.balance);

  let balanceAfter;

  if (action === "add") {
    balanceAfter = balanceBefore + amount;
  } else {
    balanceAfter = balanceBefore - amount;

    if (balanceAfter < 0) {
      return jsonResponse(
        { error: "Saldo nie może być ujemne." },
        400
      );
    }
  }

  const transactionType =
    action === "add" ? "add" : "remove";

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

  const updatedUser = await env.DB.prepare(
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

  const transactions = await env.DB.prepare(
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
    transactions: transactions.results || []
  });
}

async function requireAdmin(request, env) {
  const session = await getSession(request, env);

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

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const trimmed = cookie.trim();

    if (trimmed.startsWith(name + "=")) {
      return decodeURIComponent(
        trimmed.substring(name.length + 1)
      );
    }
  }

  return null;
}

async function getSession(request, env) {
  const raw = getCookie(
    request,
    SESSION_COOKIE
  );

  if (!raw) {
    return null;
  }

  const parts = raw.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payloadBase64 = parts[0];
  const signature = parts[1];

  const expectedSignature = await hmacSign(
    payloadBase64,
    env.SESSION_SECRET
  );

  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const json = base64UrlDecode(payloadBase64);

    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function createSession(payload, secret) {
  const json = JSON.stringify(payload);

  const payloadBase64 = base64UrlEncode(json);

  const signature = await hmacSign(
    payloadBase64,
    secret
  );

  return payloadBase64 + "." + signature;
}

async function hmacSign(value, secret) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
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
    encoder.encode(value)
  );

  return bytesToBase64Url(
    new Uint8Array(signature)
  );
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function base64UrlEncode(value) {
  return bytesToBase64Url(
    new TextEncoder().encode(value)
  );
}

function base64UrlDecode(value) {
  const binary = atob(
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/") +
      "=".repeat(
        (4 - (value.length % 4)) % 4
      )
  );

  const bytes = new Uint8Array(
    binary.length
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
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
      padding: 22px 30px;
      background: #111116;
      border-bottom: 1px solid #26262e;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      font-size: 25px;
      font-weight: 800;
      color: #ff6a00;
    }

    .back {
      color: #fff;
      text-decoration: none;
      background: #1c1c24;
      padding: 10px 15px;
      border-radius: 8px;
    }

    main {
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 20px;
    }

    h1 {
      margin-bottom: 25px;
    }

    .panel {
      background: #121218;
      border: 1px solid #282831;
      border-radius: 14px;
      padding: 22px;
      margin-bottom: 20px;
    }

    input {
      width: 100%;
      padding: 13px;
      background: #0c0c10;
      color: white;
      border: 1px solid #30303a;
      border-radius: 8px;
      margin-bottom: 12px;
      outline: none;
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 12px 18px;
      cursor: pointer;
      font-weight: 700;
      color: white;
      background: #ff6a00;
    }

    button:hover {
      opacity: .9;
    }

    .danger {
      background: #b52b2b;
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
      margin-top: 10px;
    }

    .history {
      margin-top: 25px;
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
      margin-bottom: 7px;
    }

    .add {
      color: #45d483;
    }

    .remove {
      color: #ff5d5d;
    }

    .muted {
      color: #8e8e99;
      font-size: 13px;
    }

    .error {
      color: #ff5d5d;
      margin-top: 12px;
    }

    .success {
      color: #45d483;
      margin-top: 12px;
    }

    @media (max-width: 650px) {
      .actions {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="logo">TAP ROLEPLAY — ADMIN</div>
    <a class="back" href="/">← Sklep</a>
  </header>

  <main>
    <h1>Panel administracyjny</h1>

    <div class="panel">
      <h2>Znajdź gracza</h2>

      <input
        id="discordId"
        type="text"
        placeholder="Discord ID gracza"
      >

      <button id="searchButton">
        Szukaj
      </button>

      <div id="message"></div>

      <div id="userInfo" class="user-info">
        <h2 id="username"></h2>

        <div class="muted" id="playerDiscordId"></div>

        <div class="balance" id="balance">
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
          <button id="addButton">
            + Dodaj środki
          </button>

          <button id="removeButton" class="danger">
            − Odejmij środki
          </button>
        </div>

        <div class="history">
          <h2>Historia transakcji</h2>
          <div id="history"></div>
        </div>
      </div>
    </div>
  </main>

<script>
(function () {
  var discordIdInput = document.getElementById("discordId");
  var searchButton = document.getElementById("searchButton");
  var message = document.getElementById("message");
  var userInfo = document.getElementById("userInfo");
  var username = document.getElementById("username");
  var playerDiscordId = document.getElementById("playerDiscordId");
  var balance = document.getElementById("balance");
  var amountInput = document.getElementById("amount");
  var addButton = document.getElementById("addButton");
  var removeButton = document.getElementById("removeButton");
  var history = document.getElementById("history");

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showMessage(text, type) {
    message.className = type || "";
    message.textContent = text || "";
  }

  function renderUser(data) {
    var user = data.user;

    userInfo.style.display = "block";

    username.textContent = user.username;
    playerDiscordId.textContent =
      "Discord ID: " + user.discord_id;

    balance.textContent =
      Number(user.balance).toLocaleString("pl-PL") +
      " PLN";

    renderHistory(data.transactions || []);
  }

  function renderHistory(transactions) {
    if (!transactions.length) {
      history.innerHTML =
        '<div class="muted">Brak transakcji.</div>';
      return;
    }

    var html = "";

    transactions.forEach(function (transaction) {
      var isAdd = transaction.type === "add";

      html +=
        '<div class="transaction">' +
          '<div class="transaction-top">' +
            '<strong class="' +
              (isAdd ? "add" : "remove") +
            '">' +
              (isAdd ? "DODANIE" : "ODJĘCIE") +
            '</strong>' +
            '<strong class="' +
              (isAdd ? "add" : "remove") +
            '">' +
              (isAdd ? "+" : "-") +
              Number(transaction.amount).toLocaleString("pl-PL") +
              " PLN" +
            '</strong>' +
          '</div>' +

          '<div class="muted">' +
            "Saldo: " +
            Number(transaction.balance_before).toLocaleString("pl-PL") +
            " PLN → " +
            Number(transaction.balance_after).toLocaleString("pl-PL") +
            " PLN" +
          '</div>' +

          '<div class="muted">' +
            "Administrator: " +
            escapeHtml(transaction.admin_discord_id) +
          '</div>' +

          '<div class="muted">' +
            escapeHtml(transaction.created_at) +
          '</div>' +
        '</div>';
    });

    history.innerHTML = html;
  }

  async function searchUser() {
    var discordId = discordIdInput.value.trim();

    if (!/^\\d{5,25}$/.test(discordId)) {
      showMessage(
        "Podaj prawidłowe Discord ID.",
        "error"
      );
      return;
    }

    showMessage("Szukanie...", "");
    userInfo.style.display = "none";

    try {
      var response = await fetch(
        "/api/admin/user?id=" +
        encodeURIComponent(discordId)
      );

      var data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Nie udało się pobrać gracza."
        );
      }

      showMessage("", "");
      renderUser(data);
    } catch (error) {
      showMessage(error.message, "error");
    }
  }

  async function changeBalance(action) {
    var discordId = discordIdInput.value.trim();
    var amount = Number(amountInput.value);

    if (!/^\\d{5,25}$/.test(discordId)) {
      showMessage(
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
        "Kwota musi być liczbą całkowitą od 1 do 1000000.",
        "error"
      );
      return;
    }

    showMessage("Zapisywanie...", "");

    try {
      var response = await fetch(
        "/api/admin/balance",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            discord_id: discordId,
            action: action,
            amount: amount
          })
        }
      );

      var data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Nie udało się zmienić salda."
        );
      }

      amountInput.value = "";

      showMessage(
        "Saldo zostało zmienione.",
        "success"
      );

      renderUser(data);
    } catch (error) {
      showMessage(error.message, "error");
    }
  }

  searchButton.addEventListener(
    "click",
    searchUser
  );

  discordIdInput.addEventListener(
    "keydown",
    function (event) {
      if (event.key === "Enter") {
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
})();
</script>

</body>
</html>`;
}
