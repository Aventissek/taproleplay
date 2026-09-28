export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/callback") {
      return new Response(
        "<h1>Logowanie Discord</h1><p>Callback działa. Za chwilę podłączymy dane użytkownika.</p>",
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
