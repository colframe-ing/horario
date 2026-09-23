// Service Worker — COLFRAME Operaciones
//
// ════════════════════════════════════════════════════════════════════════════
// EL BUMP DE VERSIÓN YA NO ES OBLIGATORIO (hallazgo R2-21)
// ════════════════════════════════════════════════════════════════════════════
//
// Antes este archivo era **cache-first para todo**, HTML y JS incluidos:
//
//     caches.match(req).then(cached => cached || fetch(req))
//
// O sea que un navegador que ya hubiera entrado una vez servía el código viejo
// para siempre, y la única forma de sacarlo del cache era subir `CACHE` a mano.
// Se hizo 63 veces. Cada una era una oportunidad de olvidarse, y olvidarse no
// da error: deja a la gente usando la versión anterior **en silencio**, que es
// el peor modo de falla posible. El `README.md` documentaba la trampa tres
// veces — la señal de que había que quitarla, no de que había que explicarla.
//
// Ahora el CÓDIGO (páginas, JS, CSS, manifest) va **network-first**: la red
// manda y el cache es solo el respaldo de offline. Subir un archivo alcanza
// para que se vea. `CACHE` se queda porque `activate` sigue barriendo caches
// viejos, pero subirlo pasó a ser opcional.
//
// EL COSTO, dicho claro: con red lenta se espera hasta `TIMEOUT_MS` antes de
// caer al cache, así que hay un tope de espera que antes no existía. Y con red
// muy mala se puede servir una copia **una carga atrás** —la última que sí
// llegó—. Se prefiere eso a un spinner eterno: quien marca entrada en obra
// necesita la pantalla, y las marcaciones van a la API igual (abajo), que
// nunca se cachea.
// ════════════════════════════════════════════════════════════════════════════

const CACHE = 'colframe-v64';

// Cuánto se le da a la red antes de servir del cache. Suficiente para un 3G
// flojo, poco para que se sienta colgado.
const TIMEOUT_MS = 4000;

const STATIC = [
  './', './index.html', './app.html', './admin.html', './produccion.html', './cotizaciones.html', './programacion.html', './proyecto.html', './remisiones.html', './facturacion.html',
  './css/styles.css',
  './js/config.js', './js/api.js', './js/geo.js', './js/app.js', './js/admin.js', './js/produccion.js', './js/cotizaciones.js', './js/programacion.js', './js/materiales.js', './js/proyecto.js', './js/remisiones.js', './js/facturacion.js',
  './manifest.json',
];
// Los recursos externos van aparte: cache.addAll es todo-o-nada, así que si
// Google Fonts falla durante la instalación el SW nunca se activa y se pierde
// el offline completo (hallazgo R2-22 del review).
const STATIC_EXTERNOS = [
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC).then(() => c.addAll(STATIC_EXTERNOS).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/** ¿Es código nuestro? Es lo que tiene que ir network-first: si cambia y no se
 *  ve, el sistema miente. Las fuentes y los iconos no cambian, y pagar red por
 *  ellos en cada carga sería empeorar el arranque sin ganar nada. */
function esCodigo(req) {
  if (req.mode === 'navigate') return true;              // cualquier página
  if (new URL(req.url).origin !== self.location.origin) return false;
  return /\.(html|js|css)$|manifest\.json$|\/$/.test(new URL(req.url).pathname);
}

/** Red con tope de espera. Sin esto, una conexión que ni responde ni falla
 *  —el caso de obra, no el de avión— deja la pantalla colgada, y el cache que
 *  la habría salvado no se llega a consultar nunca. */
function redConTope(req) {
  return new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error('timeout')), TIMEOUT_MS);
    fetch(req).then(
      (res) => { clearTimeout(reloj); resolver(res); },
      (err) => { clearTimeout(reloj); rechazar(err); }
    );
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;

  // Solo GET. Un POST no se cachea ni se reintenta desde acá: `remGuardar` y
  // `marcar` mueven inventario y nómina, y un reintento silencioso del Service
  // Worker sería una escritura duplicada que nadie pidió.
  if (req.method !== 'GET') return;

  // La API siempre a la red, sin tocar. Es lo único que ya hacía bien.
  if (req.url.includes('script.google.com')) return;

  if (esCodigo(req)) {
    e.respondWith(
      redConTope(req)
        .then((res) => {
          // Se refresca el cache con lo que sí llegó, para que el respaldo de
          // offline sea la última versión buena y no la del primer día.
          // `clone()` antes de devolver: el body se consume una sola vez.
          if (res && res.ok) {
            const copia = res.clone();
            e.waitUntil(caches.open(CACHE).then(c => c.put(req, copia)));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => {
            if (cached) return cached;
            // Una navegación sin cache propio cae al login, que es la puerta
            // del sistema — mejor eso que el error del navegador.
            if (req.mode === 'navigate') return caches.match('./index.html');
            return Response.error();
          })
        )
    );
    return;
  }

  // Todo lo demás (fuentes, iconos, SVG): cache-first, como antes.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
