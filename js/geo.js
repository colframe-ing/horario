// ============================================================
// GEO — Geolocalización y validación de planta
// ============================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const toR  = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a    = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getPosicion() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Tu dispositivo no soporta geolocalización'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, precision: Math.round(pos.coords.accuracy) }),
      err => {
        const msgs = {
          1: 'Debes permitir el acceso a la ubicación. Ve a configuración del navegador y actívala.',
          2: 'No se pudo obtener tu ubicación. Intenta de nuevo.',
          3: 'Tiempo de espera agotado. Intenta de nuevo.',
        };
        reject(new Error(msgs[err.code] || 'Error de ubicación'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

/**
 * La sede más cercana y si se está dentro de su radio (24-nov: hay dos sedes).
 * `sedes` llega del servidor con el estado ([{ nombre, lat, lng, radio }]); sin
 * ella, la planta de CONFIG, como antes. Es solo para avisar en el celular:
 * quien decide es el servidor, con la misma regla (`_sedeDe` en Code.gs).
 */
function sedeMasCercana(lat, lng, sedes) {
  const lista = (sedes && sedes.length) ? sedes
    : [{ nombre: 'la planta', lat: CONFIG.PLANTA_LAT, lng: CONFIG.PLANTA_LNG, radio: CONFIG.RADIO_METROS }];
  let mejor = null;
  lista.forEach(s => {
    const d = haversine(lat, lng, s.lat, s.lng);
    const dentro = d <= s.radio;
    if (!mejor || (dentro && !mejor.dentro) || (dentro === mejor.dentro && d < mejor.distancia)) {
      mejor = { sede: s, distancia: d, dentro };
    }
  });
  return mejor;
}

async function validarEnPlanta(sedes) {
  const { lat, lng, precision } = await getPosicion();
  const m = sedeMasCercana(lat, lng, sedes);
  return { enPlanta: m.dentro, distancia: Math.round(m.distancia), sede: m.sede.nombre, radio: m.sede.radio,
           lat, lng, precision };
}
