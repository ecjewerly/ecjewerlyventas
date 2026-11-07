# EC Jewelry · App de vendedores

App web (PWA) para el equipo de ventas de EC Jewelry: metas y comisiones, catálogo, manual de vendedores y flujo de entregas (pedir horario → Paulo asigna → el vendedor lo envía al cliente → pendiente de entrega).

- `public/` — la app (HTML/CSS/JS sin build). Se publica tal cual.
- `public/sw.js` — sube `VERSION` en cada cambio visible para que los celulares instalados se actualicen.
- `wrangler.jsonc` — publicación en Cloudflare (assets estáticos).

> Versión de prueba: los datos viven en cada dispositivo. PIN de prueba incluidos; cámbialos antes de lanzar.
