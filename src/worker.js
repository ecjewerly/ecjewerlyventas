// Servidor de datos de EC Jewelry (Cloudflare Worker + Durable Object con SQLite).
// La app (carpeta public/) se sirve como archivos estáticos; todo lo demás pasa por /api.
// Los PIN viven SOLO aquí (nunca en el código): el primer acceso crea el PIN de Paulo ("claim").
import { DurableObject } from "cloudflare:workers";

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const COLS = ["ventas", "piezas", "vendedores", "bonos"];
const PIN = /^\d{4}$/;
const ESTADOS_PIEZA = ["disponible", "apartada", "agotada", "vendida", "borrador"];
const DIAS = 86400000;

// Transiciones que un vendedor puede hacer en una venta (Paulo puede todas).
const TRANS = {
  por_confirmar: ["por_confirmar", "cancelada"],
  propuesta: ["propuesta", "agendada", "por_confirmar", "cancelada"],
  agendada: ["agendada", "entregada", "no_show", "cancelada", "por_confirmar"],
  no_show: ["no_show", "por_confirmar", "cancelada"],
  entregada: ["entregada"],
  cancelada: ["cancelada"],
};

const minimo = (o) => ({
  id: o.id, vendedorId: o.vendedorId, estado: o.estado, fecha: o.fecha, hora: "",
  precio: o.precio, descuento: o.descuento, pieza: "", cliente: "", punto: "", material: "", pago: "",
});

export class Datos extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      const q = (s) => this.sql.exec(s);
      q(`CREATE TABLE IF NOT EXISTS reg(c TEXT, id TEXT, s INTEGER, j TEXT, PRIMARY KEY(c,id))`);
      q(`CREATE INDEX IF NOT EXISTS reg_s ON reg(s)`);
      q(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
      q(`CREATE TABLE IF NOT EXISTS ses(t TEXT PRIMARY KEY, rol TEXT, id TEXT, c INTEGER)`);
      q(`CREATE TABLE IF NOT EXISTS fotos(id TEXT PRIMARY KEY, d TEXT)`);
      q(`CREATE TABLE IF NOT EXISTS fallos(k TEXT PRIMARY KEY, n INTEGER, hasta INTEGER)`);
    });
  }

  // ---------- utilidades ----------
  get(k) { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? r.v : null; }
  set(k, v) { this.sql.exec("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", k, String(v)); }
  sig() { const n = (+this.get("seq") || 0) + 1; this.set("seq", n); return n; }
  fila(c, id) {
    const r = this.sql.exec("SELECT s,j FROM reg WHERE c=? AND id=?", c, id).toArray()[0];
    return r ? { s: r.s, o: r.j === null ? null : JSON.parse(r.j) } : null;
  }
  escribir(c, id, o) {
    const s = this.sig();
    this.sql.exec("INSERT OR REPLACE INTO reg(c,id,s,j) VALUES(?,?,?,?)", c, id, s, o === null ? null : JSON.stringify(o));
    return s;
  }
  token(rol, id) {
    const t = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    this.sql.exec("DELETE FROM ses WHERE c<?", Date.now() - 120 * DIAS);
    this.sql.exec("INSERT INTO ses(t,rol,id,c) VALUES(?,?,?,?)", t, rol, id || "", Date.now());
    return t;
  }
  quien(t) {
    if (!t) return null;
    const r = this.sql.exec("SELECT rol,id,c FROM ses WHERE t=?", String(t)).toArray()[0];
    if (!r || Date.now() - r.c > 120 * DIAS) return null;
    return { rol: r.rol, id: r.id };
  }
  vendedores() {
    return this.sql.exec("SELECT j FROM reg WHERE c='vendedores' AND j IS NOT NULL").toArray().map((r) => JSON.parse(r.j));
  }
  bloqueo(k) {
    const r = this.sql.exec("SELECT n,hasta FROM fallos WHERE k=?", k).toArray()[0];
    return r && r.hasta > Date.now() ? Math.ceil((r.hasta - Date.now()) / 1000) : 0;
  }
  fallo(k) {
    const r = this.sql.exec("SELECT n FROM fallos WHERE k=?", k).toArray()[0];
    const n = (r ? r.n : 0) + 1;
    if (n >= 5) this.sql.exec("INSERT OR REPLACE INTO fallos(k,n,hasta) VALUES(?,?,?)", k, 0, Date.now() + 5 * 60000);
    else this.sql.exec("INSERT OR REPLACE INTO fallos(k,n,hasta) VALUES(?,?,?)", k, n, 0);
  }
  limpiarFallos(k) { this.sql.exec("DELETE FROM fallos WHERE k=?", k); }
  // lo que cada rol puede ver de un registro
  vista(rol, yoId, c, o) {
    if (rol === "admin") return o;
    if (c === "vendedores") { const { pin, ...r } = o; return r; }
    if (c === "ventas" && o.vendedorId !== yoId) return minimo(o);
    return o;
  }

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const f = url.searchParams.get("foto");
      if (f) {
        const r = this.sql.exec("SELECT d FROM fotos WHERE id=?", f).toArray()[0];
        const m = r && r.d.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) return new Response("", { status: 404 });
        const bin = atob(m[2]); const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return new Response(u8, { headers: { "content-type": m[1], "cache-control": "public, max-age=31536000, immutable" } });
      }
      return J({ ok: true, app: "ecj" });
    }
    let b;
    try { b = await req.json(); } catch (_) { return J({ ok: false, e: "json" }, 400); }
    try {
      switch (b.op) {
        case "ping": return J({ ok: true, app: "ecj", claim: !this.get("adminPin") });
        case "lista": return this.lista();
        case "claim": return this.claim(b);
        case "login": return this.login(b);
        case "logout": this.sql.exec("DELETE FROM ses WHERE t=?", String(b.t || "")); return J({ ok: true });
        case "sync": return this.sync(b);
        case "adminpin": return this.adminpin(b);
        default: return J({ ok: false, e: "op" }, 400);
      }
    } catch (e) {
      return J({ ok: false, e: "interno", m: String(e && e.message || e) }, 500);
    }
  }

  lista() {
    const v = this.vendedores().filter((x) => x.activo !== false).map((x) => ({ id: x.id, nombre: x.nombre }));
    return J({ ok: true, claim: !this.get("adminPin"), vend: v });
  }
  claim(b) {
    if (this.get("adminPin")) return J({ ok: false, e: "ya" });
    if (!PIN.test(String(b.pin))) return J({ ok: false, e: "pin" });
    this.set("adminPin", b.pin);
    return J({ ok: true, t: this.token("admin", ""), me: { rol: "admin" } });
  }
  login(b) {
    const rol = b.rol === "admin" ? "admin" : "vendedor";
    const k = rol + ":" + (b.id || "");
    const seg = this.bloqueo(k);
    if (seg) return J({ ok: false, e: "bloqueado", seg });
    let ok = false, me = { rol };
    if (rol === "admin") {
      const p = this.get("adminPin");
      if (!p) return J({ ok: false, e: "sin_admin" });
      ok = String(b.pin) === p;
    } else {
      const f = this.fila("vendedores", String(b.id || ""));
      ok = !!(f && f.o && f.o.activo !== false && String(b.pin) === f.o.pin);
      me.id = String(b.id || "");
    }
    if (!ok) { this.fallo(k); return J({ ok: false, e: "pin" }); }
    this.limpiarFallos(k);
    return J({ ok: true, t: this.token(rol, me.id), me });
  }
  adminpin(b) {
    const q = this.quien(b.t);
    if (!q || q.rol !== "admin") return J({ ok: false, e: "auth" }, 401);
    if (!PIN.test(String(b.pin))) return J({ ok: false, e: "pin" });
    if (this.vendedores().some((v) => v.pin === b.pin)) return J({ ok: false, e: "en_uso" });
    this.set("adminPin", b.pin);
    return J({ ok: true });
  }

  // ---------- sincronización ----------
  guardarFoto(id, o) {
    if (o && typeof o.foto === "string" && o.foto.startsWith("data:")) {
      const fid = id + "-" + this.sig();
      this.sql.exec("INSERT OR REPLACE INTO fotos(id,d) VALUES(?,?)", fid, o.foto);
      o.foto = "/api?foto=" + encodeURIComponent(fid);
    }
    return o;
  }
  aplicar(q, c, it) {
    const id = String(it.r ? it.r.id : it.id || "");
    if (!id) return { e: "id" };
    const cur = this.fila(c, id);
    const admin = q.rol === "admin";
    const base = +it.b || 0;

    if (it.del) {
      if (!admin) return { e: "permiso" };
      if (cur && cur.o) this.escribir(c, id, null);
      return null;
    }
    let o = it.r;
    if (typeof o !== "object" || o === null) return { e: "datos" };
    o = { ...o, id };

    if (!admin) {
      if (c === "ventas") {
        if (o.vendedorId !== q.id) return { e: "permiso" };
        if (cur && cur.o) {
          if (cur.o.vendedorId !== q.id) return { e: "permiso" };
          if (cur.s > base && JSON.stringify(cur.o) !== JSON.stringify(o)) return { e: "conflicto" };
          const ant = cur.o.estado, nue = o.estado;
          if (!(TRANS[ant] || []).includes(nue)) return { e: "estado" };
          // Solo Paulo decide día y hora de un horario propuesto o agendado.
          if (["propuesta", "agendada"].includes(ant) && ["propuesta", "agendada"].includes(nue)
              && (o.fecha !== cur.o.fecha || o.hora !== cur.o.hora)) return { e: "horario" };
          // Un vendedor no puede dejar una venta "propuesta" si no venía así.
          if (nue === "propuesta" && ant !== "propuesta") return { e: "estado" };
        } else if (o.estado !== "por_confirmar") return { e: "estado" };
        o.vendedorId = q.id;
      } else if (c === "piezas") {
        // El vendedor solo puede cambiar el estado de una pieza (apartar / liberar / vender).
        if (!ESTADOS_PIEZA.includes(o.estado)) return { e: "permiso" };
        // Si la pieza aún no está en el servidor (viene del catálogo base), solo se guarda su estado.
        o = cur && cur.o ? { ...cur.o, estado: o.estado } : { id, estado: o.estado };
      } else return { e: "permiso" };
    } else {
      if (c !== "piezas" && cur && cur.o && cur.s > base && JSON.stringify(cur.o) !== JSON.stringify(o)) return { e: "conflicto" };
      if (c === "vendedores") {
        if (!o.nombre || !PIN.test(String(o.pin))) return { e: "datos" };
        if (o.pin === this.get("adminPin")) return { e: "en_uso" };
        if (this.vendedores().some((v) => v.id !== id && v.pin === o.pin)) return { e: "en_uso" };
        if (cur && cur.o && cur.o.pin !== o.pin) this.sql.exec("DELETE FROM ses WHERE rol='vendedor' AND id=?", id);
      }
    }
    if (c === "piezas") o = this.guardarFoto(id, o);
    this.escribir(c, id, o);
    return null;
  }
  sync(b) {
    const q = this.quien(b.t);
    if (!q) return J({ ok: false, e: "auth" }, 401);
    if (q.rol === "vendedor") {
      const f = this.fila("vendedores", q.id);
      if (!f || !f.o || f.o.activo === false) return J({ ok: false, e: "auth" }, 401);
    }
    const rej = [];
    const push = b.push || {};
    for (const c of COLS) {
      for (const it of Array.isArray(push[c]) ? push[c] : []) {
        const r = this.aplicar(q, c, it);
        if (r) {
          const id = String(it.r ? it.r.id : it.id || "");
          const cur = id && this.fila(c, id);
          rej.push({ c, id, e: r.e, fix: cur ? (cur.o ? { s: cur.s, r: this.vista(q.rol, q.id, c, cur.o) } : { s: cur.s, del: true }) : null });
        }
      }
    }
    if (q.rol === "admin" && b.cfg && typeof b.cfg.comision === "number" && b.cfg.comision >= 0 && b.cfg.comision <= 100) {
      this.set("comision", b.cfg.comision);
    }
    const since = +b.since || 0;
    const ch = {}, del = {};
    for (const c of COLS) { ch[c] = []; del[c] = []; }
    for (const r of this.sql.exec("SELECT c,id,s,j FROM reg WHERE s>? ORDER BY s", since).toArray()) {
      if (r.j === null) { del[r.c].push(r.id); continue; }
      ch[r.c].push({ s: r.s, r: this.vista(q.rol, q.id, r.c, JSON.parse(r.j)) });
    }
    const com = this.get("comision");
    return J({ ok: true, seq: +this.get("seq") || 0, ch, del, rej, cfg: { comision: com === null ? 10 : +com }, me: q });
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api") {
      return env.DB.get(env.DB.idFromName("ecj")).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
