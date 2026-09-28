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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Logowanie przez Discord
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

    // Powrót z Discorda
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

    // Informacje o zalogowanym użytkowniku
    if (url.pathname === "/me") {
      const cookie =
        request.headers.get("Cookie") || "";

      const match =
        cookie.match(/tap_session=([^;]+)/);

      if (!match) {
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

      try {
        const decoded =
          atob(match[1].split(".")[0]);

        const separator =
          decoded.indexOf(":");

        if (separator === -1) {
          throw new Error("Invalid session");
        }

        const discordId =
          decoded.slice(0, separator);

        const username =
          decoded.slice(separator + 1);

        return new Response(
          JSON.stringify({
            loggedIn: true,
            discordId,
            username,
            balance: 0
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      } catch {
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
    }

    // Reszta strony
    return env.ASSETS.fetch(request);
  }
};
