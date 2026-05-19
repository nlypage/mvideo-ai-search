import { createFileRoute } from "@tanstack/react-router";

const FAVICON_URL = "https://static.mvideo.ru/media/Assets/facelift/img/icon/svg/101024/mclub.svg";

export const Route = createFileRoute("/favicon.ico")({
  server: {
    handlers: {
      GET: async () => Response.redirect(FAVICON_URL, 302),
    },
  },
});
