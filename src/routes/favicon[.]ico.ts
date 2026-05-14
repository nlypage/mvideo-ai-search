import { createFileRoute } from "@tanstack/react-router";

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>М.Видео</title>
  <rect width="32" height="32" rx="7" fill="#e30613"/>
  <g transform="translate(1.7 3.2) scale(1.32)">
    <path fill="#fff" d="M4.13 16.88c1.86 0 2.84-1.83 3.7-4.3h.14c-.35 2.14-.24 4.3 1.82 4.3 1.85 0 2.74-1.84 3.51-4.3h.14c-.36 2.1-.26 4.3 1.85 4.3 1.85 0 2.9-1.8 3.3-4.29h-1.3c-.16.55-.42 1.1-.9 1.1-1.01 0-.46-1.65-.02-3.7L17.01 7H13.9s-1.65 6.68-2.95 6.68c-.95 0-.48-1.83-.08-3.72L11.5 7H8.4c-.59 2.22-1.82 6.68-2.96 6.68-.38 0-.47-.23-.47-.52 0-.2.05-.4.12-.57H2.23c-.15.6-.23 1.16-.23 1.74 0 1.45.55 2.55 2.13 2.55Zm16.17 0c.8 0 1.46-.63 1.46-1.41 0-.78-.66-1.41-1.46-1.41-.81 0-1.47.63-1.47 1.4 0 .79.66 1.42 1.47 1.42Z"/>
  </g>
</svg>`;

export const Route = createFileRoute("/favicon.ico")({
  server: {
    handlers: {
      GET: async () =>
        new Response(FAVICON_SVG, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        }),
    },
  },
});
