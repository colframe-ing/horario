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

async function validarEnPlanta(onProgress) {
  if (onProgress) onProgress('Obteniendo GPS...');
  const { lat, lng, precision } = await getPosicion();
  const distancia = Math.round(haversine(lat, lng, CONFIG.PLANTA_LAT, CONFIG.PLANTA_LNG));
  const enPlanta  = distancia <= CONFIG.RADIO_METROS;
  return { enPlanta, distancia, lat, lng, precision };
}
