export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      const discordUrl =
        "https://discord.com/oauth2/authorize" +
        "?client_id=" + encodeURIComponent(env.DISCORD_CLIENT_ID) +
        "&response_type=code" +
        "&redirect_uri=" + encodeURIComponent(
          "https://taproleplay.kosscirzynskikuba-4a4.workers.dev/callback"
        ) +
        "&scope=identify";

      return Response.redirect(discordUrl, 302);
    }

    if (url.pathname === "/callback") {
      return new Response(
        "<h1>Logowanie Discord</h1><p>Callback działa.</p>",
        {
          headers: {
            "content-type": "text/html;charset=UTF-8"
          }
        }
      );
    }

    return new Response("TAP Roleplay Worker działa!");
  }
};
