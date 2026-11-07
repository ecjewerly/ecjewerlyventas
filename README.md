# EC Jewelry · App de vendedores

App web (PWA) para el equipo de ventas de EC Jewelry: metas y comisiones, catálogo, manual de vendedores y flujo de entregas (pedir horario → Paulo asigna → el vendedor lo envía al cliente → pendiente de entrega).

- `public/` — la app (HTML/CSS/JS sin build). `public/sw.js`: sube `VERSION` en cada cambio visible para que los celulares instalados se actualicen.
- `src/worker.js` — servidor de datos (Cloudflare Worker + Durable Object con SQLite): sesiones por PIN, pedidos, catálogo, equipo y fotos.
- `wrangler.jsonc` — configuración de publicación en Cloudflare. Cada `git push` a `main` se publica solo.

Los PIN **no están en el código**: la primera vez que se abre la app, Paulo crea su PIN de administrador y después da de alta a los vendedores (cada uno con su PIN) desde la pestaña Equipo.
