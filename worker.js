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

  const signatureBytes = Uint8Array.from(
    atob(signature),
    char => char.charCodeAt(0)
  );

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // LOGOWANIE DISCORD
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

    // CALLBACK DISCORD
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");

      if (!code) {
        return new Response("Brak kodu autoryzacyjnego.", {
          status: 400
        });
      }

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
            redirect_uri:
              "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback"
          })
        }
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok) {
        return new Response("Nie udało się zalogować przez Discord.", {
          status: 400
        });
      }

      const userResponse = await fetch(
        "https://discord.com/api/users/@me",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`
          }
        }
      );

      const user = await userResponse.json();

      if (!user.id || !user.username) {
        return new Response("Nie udało się pobrać danych Discord.", {
          status: 400
        });
      }

      // Dodaj użytkownika do D1, jeśli jeszcze go nie ma
      await env.DB.prepare(`
        INSERT INTO users (discord_id, username)
        VALUES (?, ?)
        ON CONFLICT(discord_id)
        DO UPDATE SET
          username = excluded.username,
          updated_at = CURRENT_TIMESTAMP
      `)
        .bind(user.id, user.username)
        .run();

      const sessionData = `${user.id}:${user.username}`;

      const signature = await sign(
        sessionData,
        env.SESSION_SECRET
      );

      const cookieValue =
        btoa(sessionData) + "." + signature;

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie":
            `tap_session=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
        }
      });
    }

    // DANE ZALOGOWANEGO UŻYTKOWNIKA
    if (url.pathname === "/me") {
      const session = await getSession(request, env);

      if (!session) {
        return new Response(
          JSON.stringify({
            loggedIn: false
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      const user = await env.DB.prepare(`
        SELECT discord_id, username, balance
        FROM users
        WHERE discord_id = ?
      `)
        .bind(session.discordId)
        .first();

      if (!user) {
        return new Response(
          JSON.stringify({
            loggedIn: false
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      const isAdmin =
        session.discordId === env.ADMIN_DISCORD_ID;

      return new Response(
        JSON.stringify({
          loggedIn: true,
          discordId: user.discord_id,
          username: user.username,
          balance: user.balance,
          isAdmin
        }),
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    // RESZTA STRONY
    return env.ASSETS.fetch(request);
  }
};
