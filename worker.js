async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function verify(value, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  let signatureBytes;

  try {
    signatureBytes = Uint8Array.from(
      atob(signature),
      char => char.charCodeAt(0)
    );
  } catch {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(value)
  );
}

async function getSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/tap_session=([^;]+)/);

  if (!match) {
    return null;
  }

  try {
    const parts = match[1].split(".");

    if (parts.length !== 2) {
      return null;
    }

    const encodedData = parts[0];
    const signature = parts[1];

    const sessionData = atob(encodedData);

    const valid = await verify(
      sessionData,
      signature,
      env.SESSION_SECRET
    );

    if (!valid) {
      return null;
    }

    const separator = sessionData.indexOf(":");

    if (separator === -1) {
      return null;
    }

    return {
      discordId: sessionData.slice(0, separator),
      username: sessionData.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

async function requireAdmin(request, env) {
  const session = await getSession(request, env);

  if (!session) {
    return null;
  }

  if (session.discordId !== env.ADMIN_DISCORD_ID) {
    return null;
  }

  return session;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function adminPage() {
  return new Response(`<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>TAP Roleplay — Panel Admina</title>

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: Arial, sans-serif;
      background: #0b0b0b;
      color: white;
      min-height: 100vh;
    }

    header {
      min-height: 75px;
      background: #111;
      border-bottom: 1px solid #252525;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 15px 7%;
    }

    .logo {
      font-size: 25px;
      font-weight: bold;
    }

    .logo span {
      color: #f97316;
    }

    .back {
      color: white;
      text-decoration: none;
      background: #252525;
      padding: 10px 16px;
      border-radius: 7px;
    }

    .back:hover {
      background: #333;
    }

    main {
      max-width: 950px;
      margin: 50px auto;
      padding: 0 20px;
    }

    h1 {
      margin-bottom: 10px;
    }

    .subtitle {
      color: #888;
      margin-bottom: 30px;
    }

    .box {
      background: #151515;
      border: 1px solid #252525;
      border-radius: 12px;
      padding: 25px;
      margin-bottom: 20px;
    }

    label {
      display: block;
      color: #aaa;
      margin-bottom: 8px;
      font-size: 14px;
    }

    input {
      width: 100%;
      padding: 13px;
      background: #0b0b0b;
      border: 1px solid #333;
      border-radius: 7px;
      color: white;
      outline: none;
      margin-bottom: 12px;
    }

    input:focus {
      border-color: #f97316;
    }

    button {
      border: none;
      border-radius: 7px;
      padding: 12px 18px;
      color: white;
      font-weight: bold;
      cursor: pointer;
    }

    .search {
      background: #f97316;
    }

    .search:hover {
      background: #ea580c;
    }

    .player {
      display: none;
    }

    .player-name {
      font-size: 22px;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .player-id {
      color: #777;
      font-size: 13px;
      margin-bottom: 20px;
      word-break: break-all;
    }

    .balance {
      font-size: 30px;
      color: #f97316;
      font-weight: bold;
      margin-bottom: 25px;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .amount {
      grid-column: 1 / -1;
      margin-bottom: 0;
    }

    .add {
      background: #16a34a;
    }

    .add:hover {
      background: #15803d;
    }

    .remove {
      background: #dc2626;
    }

    .remove:hover {
      background: #b91c1c;
    }

    .message {
      margin-top: 15px;
      color: #aaa;
      min-height: 20px;
    }

    .history-title {
      margin-bottom: 15px;
      font-size: 20px;
    }

    .history {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .transaction {
      background: #0f0f0f;
      border: 1px solid #252525;
      border-radius: 8px;
      padding: 15px;
    }

    .transaction-top {
      display: flex;
      justify-content: space-between;
      gap: 15px;
      margin-bottom: 7px;
    }

    .transaction-type {
      font-weight: bold;
    }

    .transaction-add {
      color: #22c55e;
    }

    .transaction-remove {
      color: #ef4444;
    }

    .transaction-amount {
      font-weight: bold;
    }

    .transaction-info {
      color: #777;
      font-size: 13px;
      line-height: 1.6;
    }

    .empty-history {
      color: #777;
      padding: 10px 0;
    }

    @media (max-width: 600px) {
      .actions {
        grid-template-columns: 1fr;
      }

      .transaction-top {
        flex-direction: column;
        gap: 5px;
      }
    }
  </style>
</head>

<body>

<header>
  <div class="logo">
    TAP<span>ROLEPLAY</span>
  </div>

  <a href="/" class="back">
    ← Wróć do sklepu
  </a>
</header>

<main>

  <h1>Panel Admina</h1>

  <p class="subtitle">
    Zarządzanie saldem i historią użytkowników
  </p>

  <div class="box">

    <label for="discordId">
      Discord ID gracza
    </label>

    <input
      id="discordId"
      type="text"
      placeholder="np. 123456789012345678"
      autocomplete="off"
    >

    <button class="search" onclick="searchPlayer()">
      SZUKAJ GRACZA
    </button>

    <div class="message" id="message"></div>

  </div>

  <div class="box player" id="playerBox">

    <div class="player-name" id="playerName">
      —
    </div>

    <div class="player-id" id="playerId">
      —
    </div>

    <div class="balance" id="playerBalance">
      0 PLN
    </div>

    <div class="actions">

      <input
        class="amount"
        id="amount"
        type="number"
        min="1"
        step="1"
        placeholder="Kwota PLN"
      >

      <button class="add" onclick="changeBalance('add')">
        + DODAJ
      </button>

      <button class="remove" onclick="changeBalance('remove')">
        − ODEJMIJ
      </button>

    </div>

  </div>

  <div class="box player" id="historyBox">

    <div class="history-title">
      HISTORIA TRANSAKCJI
    </div>

    <div class="history" id="history">
    </div>

  </div>

</main>

<script>
let selectedDiscordId = null;

async function searchPlayer() {
  const discordId =
    document.getElementById("discordId").value.trim();

  const message =
    document.getElementById("message");

  const playerBox =
    document.getElementById("playerBox");

  const historyBox =
    document.getElementById("historyBox");

  if (!/^\\d{5,25}$/.test(discordId)) {
    message.textContent =
      "Podaj poprawne Discord ID.";

    playerBox.style.display = "none";
    historyBox.style.display = "none";

    return;
  }

  message.textContent =
    "Szukanie gracza...";

  try {
    const response = await fetch(
      "/api/admin/user?id=" +
      encodeURIComponent(discordId)
    );

    const data = await response.json();

    if (!response.ok || !data.found) {
      playerBox.style.display = "none";
      historyBox.style.display = "none";

      message.textContent =
        data.error || "Nie znaleziono gracza.";

      return;
    }

    selectedDiscordId =
      data.user.discord_id;

    document.getElementById(
      "playerName"
    ).textContent =
      data.user.username;

    document.getElementById(
      "playerId"
    ).textContent =
      "Discord ID: " + data.user.discord_id;

    document.getElementById(
      "playerBalance"
    ).textContent =
      data.user.balance + " PLN";

    document.getElementById(
      "amount"
    ).value = "";

    playerBox.style.display = "block";

    renderHistory(data.transactions);

    historyBox.style.display = "block";

    message.textContent = "";

  } catch {
    message.textContent =
      "Wystąpił błąd podczas wyszukiwania.";
  }
}

function renderHistory(transactions) {
  const history =
    document.getElementById("history");

  history.innerHTML = "";

  if (!transactions || transactions.length === 0) {
    history.innerHTML =
      '<div class="empty-history">Brak transakcji.</div>';

    return;
  }

  transactions.forEach(transaction => {
    const element =
      document.createElement("div");

    element.className =
      "transaction";

    const isAdd =
      transaction.type === "DODANIE";

    const sign =
      isAdd ? "+" : "-";

    const typeClass =
      isAdd
        ? "transaction-add"
        : "transaction-remove";

    element.innerHTML = `
      <div class="transaction-top">
        <div class="transaction-type ${typeClass}">
          ${escapeHtml(transaction.type)}
        </div>

        <div class="transaction-amount ${typeClass}">
          ${sign}${Number(transaction.amount)} PLN
        </div>
      </div>

      <div class="transaction-info">
        Saldo: ${Number(transaction.balance_before)}
        PLN → ${Number(transaction.balance_after)} PLN<br>

        Admin: ${escapeHtml(transaction.admin_discord_id || "—")}<br>

        Data: ${escapeHtml(transaction.created_at)}
      </div>
    `;

    history.appendChild(element);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function changeBalance(action) {
  if (!selectedDiscordId) {
    return;
  }

  const amountInput =
    document.getElementById("amount");

  const amount =
    Number(amountInput.value);

  const message =
    document.getElementById("message");

  if (!Number.isInteger(amount) || amount <= 0) {
    message.textContent =
      "Kwota musi być dodatnią liczbą całkowitą.";

    return;
  }

  message.textContent =
    "Zapisywanie...";

  try {
    const response = await fetch(
      "/api/admin/balance",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          discordId: selectedDiscordId,
          amount,
          action
        })
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      message.textContent =
        data.error ||
        "Nie udało się zmienić salda.";

      return;
    }

    document.getElementById(
      "playerBalance"
    ).textContent =
      data.balance + " PLN";

    amountInput.value = "";

    renderHistory(data.transactions);

    message.textContent =
      action === "add"
        ? "Dodano " + amount + " PLN."
        : "Odjęto " + amount + " PLN.";

  } catch {
    message.textContent =
      "Wystąpił błąd podczas zmiany salda.";
  }
}
</script>

</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // DISCORD LOGIN
    // =========================

    if (url.pathname === "/login") {
      const discordUrl =
        "https://discord.com/oauth2/authorize" +
        "?client_id=" +
        encodeURIComponent(env.DISCORD_CLIENT_ID) +
        "&response_type=code" +
        "&redirect_uri=" +
        encodeURIComponent(
          "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback"
        ) +
        "&scope=identify";

      return Response.redirect(discordUrl, 302);
    }

    // =========================
    // DISCORD CALLBACK
    // =========================

    if (url.pathname === "/callback") {
      const code =
        url.searchParams.get("code");

      if (!code) {
        return new Response(
          "Brak kodu autoryzacyjnego.",
          { status: 400 }
        );
      }

      const tokenResponse =
        await fetch(
          "https://discord.com/api/oauth2/token",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              client_id:
                env.DISCORD_CLIENT_ID,

              client_secret:
                env.DISCORD_CLIENT_SECRET,

              grant_type:
                "authorization_code",

              code,

              redirect_uri:
                "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback"
            })
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        return new Response(
          "Nie udało się zalogować przez Discord.",
          { status: 400 }
        );
      }

      const userResponse =
        await fetch(
          "https://discord.com/api/users/@me",
          {
            headers: {
              Authorization:
                `Bearer ${tokenData.access_token}`
            }
          }
        );

      const user =
        await userResponse.json();

      if (!user.id || !user.username) {
        return new Response(
          "Nie udało się pobrać danych Discord.",
          { status: 400 }
        );
      }

      await env.DB.prepare(`
        INSERT INTO users (
          discord_id,
          username
        )
        VALUES (?, ?)

        ON CONFLICT(discord_id)
        DO UPDATE SET
          username = excluded.username,
          updated_at = CURRENT_TIMESTAMP
      `)
        .bind(
          user.id,
          user.username
        )
        .run();

      const sessionData =
        `${user.id}:${user.username}`;

      const signature =
        await sign(
          sessionData,
          env.SESSION_SECRET
        );

      const cookieValue =
        btoa(sessionData) +
        "." +
        signature;

      return new Response(null, {
        status: 302,

        headers: {
          Location: "/",

          "Set-Cookie":
            `tap_session=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
        }
      });
    }

    // =========================
    // CURRENT USER
    // =========================

    if (url.pathname === "/me") {
      const session =
        await getSession(
          request,
          env
        );

      if (!session) {
        return json({
          loggedIn: false
        });
      }

      const user =
        await env.DB.prepare(`
          SELECT
            discord_id,
            username,
            balance
          FROM users
          WHERE discord_id = ?
        `)
          .bind(session.discordId)
          .first();

      if (!user) {
        return json({
          loggedIn: false
        });
      }

      const isAdmin =
        session.discordId ===
        env.ADMIN_DISCORD_ID;

      return json({
        loggedIn: true,
        discordId:
          user.discord_id,
        username:
          user.username,
        balance:
          user.balance,
        isAdmin
      });
    }

    // =========================
    // ADMIN PAGE
    // =========================

    if (url.pathname === "/admin") {
      const admin =
        await requireAdmin(
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

      return adminPage();
    }

    // =========================
    // ADMIN - SEARCH USER
    // =========================

    if (
      url.pathname ===
      "/api/admin/user"
    ) {
      const admin =
        await requireAdmin(
          request,
          env
        );

      if (!admin) {
        return json(
          {
            error:
              "Brak dostępu."
          },
          403
        );
      }

      const discordId =
        url.searchParams.get("id");

      if (
        !discordId ||
        !/^\d{5,25}$/.test(
          discordId
        )
      ) {
        return json(
          {
            error:
              "Nieprawidłowe Discord ID."
          },
          400
        );
      }

      const user =
        await env.DB.prepare(`
          SELECT
            discord_id,
            username,
            balance
          FROM users
          WHERE discord_id = ?
        `)
          .bind(discordId)
          .first();

      if (!user) {
        return json({
          found: false,
          error:
            "Nie znaleziono tego gracza w bazie."
        });
      }

      const transactions =
        await env.DB.prepare(`
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
        `)
          .bind(discordId)
          .all();

      return json({
        found: true,
        user,
        transactions:
          transactions.results || []
      });
    }

    // =========================
    // ADMIN - CHANGE BALANCE
    // =========================

    if (
      url.pathname ===
        "/api/admin/balance" &&
      request.method === "POST"
    ) {
      const admin =
        await requireAdmin(
          request,
          env
        );

      if (!admin) {
        return json(
          {
            error:
              "Brak dostępu."
          },
          403
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

      const {
        discordId,
        amount,
        action
      } = body;

      if (
        typeof discordId !==
          "string" ||
        !/^\d{5,25}$/.test(
          discordId
        )
      ) {
        return json(
          {
            error:
              "Nieprawidłowe Discord ID."
          },
          400
        );
      }

      if (
        !Number.isInteger(
          amount
        ) ||
        amount <= 0 ||
        amount > 1000000
      ) {
        return json(
          {
            error:
              "Nieprawidłowa kwota."
          },
          400
        );
      }

      if (
        action !== "add" &&
        action !== "remove"
      ) {
        return json(
          {
            error:
              "Nieprawidłowa operacja."
          },
          400
        );
      }

      const user =
        await env.DB.prepare(`
          SELECT
            discord_id,
            username,
            balance
          FROM users
          WHERE discord_id = ?
        `)
          .bind(discordId)
          .first();

      if (!user) {
        return json(
          {
            error:
              "Nie znaleziono gracza."
          },
          404
        );
      }

      const balanceBefore =
        Number(user.balance);

      let newBalance;

      if (action === "add") {
        newBalance =
          balanceBefore + amount;
      } else {
        newBalance =
          balanceBefore - amount;

        if (newBalance < 0) {
          return json(
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
          ? "DODANIE"
          : "ODJĘCIE";

      // Zmiana salda + zapis transakcji
      // wykonywane razem przez D1.
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE users
          SET
            balance = ?,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE discord_id = ?
        `)
          .bind(
            newBalance,
            discordId
          ),

        env.DB.prepare(`
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
            transactionType,
            amount,
            balanceBefore,
            newBalance,
            admin.discordId
          )
      ]);

      const transactions =
        await env.DB.prepare(`
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
        `)
          .bind(discordId)
          .all();

      return json({
        success: true,
        discordId,
        balance: newBalance,
        transactions:
          transactions.results || []
      });
    }

    // =========================
    // STATIC WEBSITE
    // =========================

    return env.ASSETS.fetch(request);
  }
};
