/**
 * Radar CDMX - Módulo Cliente de Datos (API)
 *
 * Este módulo consume los endpoints del backend Go como única fuente de datos.
 */

const API_BASE = '/api';

const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

function normalizeNullable(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null && 'Valid' in value) {
    if (!value.Valid) {
      return null;
    }
    if ('String' in value) return value.String;
    if ('Int64' in value) return value.Int64;
    if ('Float64' in value) return value.Float64;
    if ('Bool' in value) return value.Bool;
    if ('Time' in value) return value.Time;
  }

  return value;
}

function normalizeEstablecimientoListPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.Items)) return payload.Items;
  if (Array.isArray(payload.establecimiento)) return payload.establecimiento;
  if (Array.isArray(payload.Establecimiento)) return payload.Establecimiento;
  return [];
}

function classifySector(codigoActividad, nombreActividad) {
  const code = String(codigoActividad || '').padStart(2, '0').slice(0, 2);
  const activity = String(nombreActividad || '').toLowerCase();

  if (code === '71' || activity.includes('entreten') || activity.includes('esparcimiento')) {
    return 'Entretenimiento';
  }
  if (code === '72' || activity.includes('restaur') || activity.includes('alimento') || activity.includes('bar')) {
    return 'Alimentos';
  }
  if (code === '31' || code === '32' || code === '33') {
    return 'Manufactura';
  }
  return 'Comercio';
}

function parseEmployees(perOcu) {
  const text = String(perOcu || '').trim().toLowerCase();
  if (!text) return 0;

  if (text.includes('0 a 5')) return 3;
  if (text.includes('6 a 10')) return 8;
  if (text.includes('11 a 30')) return 20;
  if (text.includes('31 a 50')) return 40;
  if (text.includes('51 a 100')) return 75;
  if (text.includes('101 a 250')) return 175;
  if (text.includes('251 y más') || text.includes('251 o más')) return 300;

  const nums = text.match(/\d+/g);
  if (!nums || nums.length === 0) return 0;
  if (nums.length === 1) return Number(nums[0]);
  return Math.round((Number(nums[0]) + Number(nums[1])) / 2);
}

async function fetchJSON(path, { timeoutMs = 9000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(path, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEstablecimientosRaw() {
  const payload = await fetchJSON(`${API_BASE}/establecimientos?page_size=1000&offset=0`);
  return normalizeEstablecimientoListPayload(payload);
}

/**
 * Construye una dirección legible a partir de los campos de ubicación del DENUE
 * (calle, número, localidad/colonia, código postal y alcaldía).
 */
function buildDireccion(ubicacion) {
  const calle = normalizeNullable(ubicacion.calle ?? ubicacion.Calle) || '';
  const numExt = normalizeNullable(ubicacion.num_ext ?? ubicacion.NumExt) || '';
  const numInt = normalizeNullable(ubicacion.num_int ?? ubicacion.NumInt) || '';
  const localidad = normalizeNullable(ubicacion.localidad ?? ubicacion.Localidad) || '';
  const codigoPostal = normalizeNullable(ubicacion.codigo_postal ?? ubicacion.CodigoPostal) || '';
  const municipio = normalizeNullable(ubicacion.municipio ?? ubicacion.Municipio) || '';

  let calleLinea = calle;
  if (numExt) calleLinea += ` ${numExt}`;
  if (numInt) calleLinea += ` Int. ${numInt}`;

  const parts = [
    calleLinea.trim(),
    localidad,
    codigoPostal ? `C.P. ${codigoPostal}` : '',
    municipio
  ].filter((p) => p && p.trim() !== '');

  return parts.join(', ');
}

function mapEstablecimientoToFeature(item, index) {
  const ubicacion = item?.ubicacion || item?.Ubicacion || {};
  const lat = Number(normalizeNullable(ubicacion.latitud ?? ubicacion.Latitud));
  const lng = Number(normalizeNullable(ubicacion.longitud ?? ubicacion.Longitud));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const codigoActividad = normalizeNullable(item?.codigo_actividad ?? item?.CodigoActividad);
  const nombreActividad = normalizeNullable(item?.nombre_actividad ?? item?.NombreActividad) || 'Actividad no especificada';
  const perOcu = normalizeNullable(item?.per_ocu ?? item?.PerOcu) || '';
  const municipio = normalizeNullable(ubicacion.municipio ?? ubicacion.Municipio) || '';
  const direccion = buildDireccion(ubicacion);

  return {
    type: 'Feature',
    properties: {
      id: normalizeNullable(item?.uuid ?? item?.UUID) || `api_est_${index + 1}`,
      nombre: normalizeNullable(item?.nombre ?? item?.Nombre) || normalizeNullable(item?.razon_social ?? item?.RazonSocial) || `Establecimiento ${index + 1}`,
      clee: normalizeNullable(item?.clee ?? item?.Clee) || '',
      nombre_actividad: nombreActividad,
      codigo_actividad: codigoActividad,
      per_ocu: perOcu,
      fecha_alta: normalizeNullable(item?.fecha_alta ?? item?.FechaAlta) || '',
      uso_de_suelo: normalizeNullable(item?.uso_de_suelo ?? item?.UsoDeSuelo) || '',
      clave_catastral: normalizeNullable(item?.clave_catastral ?? item?.ClaveCatastral) || '',
      fiscalStatus: 'Activa',
      municipio,
      direccion,
      sector: classifySector(codigoActividad, nombreActividad),
      employees: parseEmployees(perOcu)
    },
    geometry: {
      type: 'Point',
      coordinates: [lng, lat]
    }
  };
}

function toGeoJSONFeatures(items) {
  const features = [];
  for (let i = 0; i < items.length; i++) {
    const feature = mapEstablecimientoToFeature(items[i], i);
    if (feature) {
      features.push(feature);
    }
  }
  return {
    type: 'FeatureCollection',
    features
  };
}

/**
 * Obtiene la capa de Zonificación de Uso de Suelo de SEDUVI (Polígonos GeoJSON)
 */
export async function fetchZoningLayer() {
  try {
    const payload = await fetchJSON(`${API_BASE}/zoning`);
    if (payload && Array.isArray(payload.features)) {
      return payload;
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/zoning.', error);
  }

  return { ...EMPTY_FEATURE_COLLECTION };
}

/**
 * Obtiene la capa de Mercados Públicos de la CDMX (Puntos GeoJSON)
 */
export async function fetchMarketsLayer() {
  try {
    const payload = await fetchJSON(`${API_BASE}/mercados`);
    if (payload && Array.isArray(payload.features)) {
      return payload;
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/mercados.', error);
  }

  return { ...EMPTY_FEATURE_COLLECTION };
}

/**
 * Obtiene la capa de Establecimientos Comerciales del DENUE (Puntos GeoJSON)
 */
export async function fetchEstablishmentsLayer() {
  try {
    const rawItems = await fetchEstablecimientosRaw();
    return toGeoJSONFeatures(rawItems);
  } catch (error) {
    console.warn('No se pudieron cargar establecimientos desde /api/establecimientos.', error);
    return { ...EMPTY_FEATURE_COLLECTION };
  }
}

/**
 * Obtiene los establecimientos cercanos a un punto dentro de un radio, usando el
 * endpoint /api/establecimientos/nearby. Soporta filtros opcionales que el
 * backend aplica directamente en la consulta (código de actividad, uso de suelo
 * y municipio/alcaldía).
 *
 * @param {Object} opts
 * @param {number} opts.lat - Latitud del centro de búsqueda
 * @param {number} opts.lng - Longitud del centro de búsqueda
 * @param {number} [opts.radiusM] - Radio de búsqueda en metros (modo radio)
 * @param {Object} [opts.bbox] - Caja delimitadora del viewport (modo rectángulo).
 *   Cuando se provee, el backend filtra por el rectángulo en vez de un radio,
 *   evitando el artefacto de "círculo" al recortar por page_size.
 * @param {number} opts.bbox.minLat
 * @param {number} opts.bbox.maxLat
 * @param {number} opts.bbox.minLng
 * @param {number} opts.bbox.maxLng
 * @param {number|string} [opts.codigoActividad] - Código de actividad exacto (SCIAN)
 * @param {string} [opts.usoDeSuelo] - Clave de uso de suelo exacta
 * @param {string} [opts.municipio] - Municipio/alcaldía exacto
 * @param {number} [opts.pageSize=5000] - Máximo de resultados
 * @param {number} [opts.offset=0] - Desplazamiento de paginación
 * @returns {Promise<Object>} FeatureCollection GeoJSON con los establecimientos
 */
export async function fetchEstablishmentsNearbyLayer({
  lat,
  lng,
  radiusM,
  bbox,
  codigoActividad,
  usoDeSuelo,
  municipio,
  q,
  pageSize = 5000,
  offset = 0
} = {}) {
  const hasBBox = bbox
    && Number.isFinite(Number(bbox.minLat)) && Number.isFinite(Number(bbox.maxLat))
    && Number.isFinite(Number(bbox.minLng)) && Number.isFinite(Number(bbox.maxLng));

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    throw new Error('lat y lng son requeridos para la búsqueda por cercanía');
  }
  if (!hasBBox && !(Number(radiusM) > 0)) {
    throw new Error('se requiere radiusM o bbox para la búsqueda por cercanía');
  }

  const params = new URLSearchParams();
  params.set('lat', String(lat));
  params.set('lng', String(lng));
  params.set('page_size', String(pageSize));
  params.set('offset', String(offset));

  if (hasBBox) {
    params.set('min_lat', String(bbox.minLat));
    params.set('max_lat', String(bbox.maxLat));
    params.set('min_lng', String(bbox.minLng));
    params.set('max_lng', String(bbox.maxLng));
  } else {
    params.set('radius_m', String(radiusM));
  }

  if (codigoActividad !== undefined && codigoActividad !== null && String(codigoActividad).trim() !== '') {
    params.set('codigo_actividad', String(codigoActividad).trim());
  }
  if (typeof usoDeSuelo === 'string' && usoDeSuelo.trim() !== '') {
    params.set('uso_de_suelo', usoDeSuelo.trim());
  }
  if (typeof municipio === 'string' && municipio.trim() !== '') {
    params.set('municipio', municipio.trim());
  }
  if (typeof q === 'string' && q.trim() !== '') {
    params.set('q', q.trim());
  }

  const payload = await fetchJSON(`${API_BASE}/establecimientos/nearby?${params.toString()}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const features = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    const establecimiento = entry?.establecimiento ?? entry?.Establecimiento ?? entry;
    const feature = mapEstablecimientoToFeature(establecimiento, i);
    if (!feature) {
      continue;
    }

    const distance = normalizeNullable(entry?.distance_meters ?? entry?.DistanceMeters);
    if (Number.isFinite(Number(distance))) {
      feature.properties.distance_meters = Number(distance);
    }
    features.push(feature);
  }

  return {
    type: 'FeatureCollection',
    features
  };
}

export async function fetchSectoresCatalog() {
  try {
    const payload = await fetchJSON(`${API_BASE}/sectores`);
    if (Array.isArray(payload)) {
      return payload;
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/sectores, usando catálogo local.', error);
  }

  return [];
}

export async function fetchActividadesCatalog(prefix2 = []) {
  const params = new URLSearchParams();
  params.set('limit', '1500');
  params.set('offset', '0');

  if (Array.isArray(prefix2) && prefix2.length > 0) {
    prefix2.forEach((p) => {
      if (p) {
        params.append('prefix2', String(p));
      }
    });
  }

  try {
    const payload = await fetchJSON(`${API_BASE}/actividades?${params.toString()}`);
    if (Array.isArray(payload?.items)) {
      return payload.items;
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/actividades, usando catálogo local.', error);
  }

  return [];
}

/**
 * Obtiene el catálogo de municipios/alcaldías distintos usados por los
 * establecimientos registrados en el backend.
 */
export async function fetchMunicipiosCatalog() {
  try {
    const payload = await fetchJSON(`${API_BASE}/municipios`);
    if (Array.isArray(payload?.items)) {
      return payload.items.filter((m) => typeof m === 'string' && m.trim() !== '');
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/municipios, usando catálogo local.', error);
  }

  return [];
}

/**
 * Obtiene el catálogo de usos de suelo distintos usados por los establecimientos
 * registrados en el backend.
 */
export async function fetchUsosDeSueloCatalog() {
  try {
    const payload = await fetchJSON(`${API_BASE}/usos-de-suelo`);
    if (Array.isArray(payload?.items)) {
      return payload.items.filter((u) => typeof u === 'string' && u.trim() !== '');
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/usos-de-suelo, usando catálogo local.', error);
  }

  return [];
}

/**
 * Compara dos municipios/alcaldías usando el endpoint /api/municipios/compare.
 * Devuelve, por cada municipio, el total de establecimientos, una estimación de
 * empleados (a partir del límite superior de los rangos per_ocu) y el conteo de
 * establecimientos por sector económico.
 *
 * @param {string} municipioA - Nombre exacto del primer municipio
 * @param {string} municipioB - Nombre exacto del segundo municipio
 * @returns {Promise<Array<Object>|null>} Arreglo con 2 comparaciones, o null si falla
 */
export async function fetchCompareMunicipios(municipioA, municipioB) {
  const a = String(municipioA || '').trim();
  const b = String(municipioB || '').trim();
  if (!a || !b) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('a', a);
  params.set('b', b);

  try {
    const payload = await fetchJSON(`${API_BASE}/municipios/compare?${params.toString()}`);
    if (Array.isArray(payload?.municipios)) {
      return payload.municipios;
    }
  } catch (error) {
    console.warn('No se pudo cargar /api/municipios/compare.', error);
  }

  return null;
}

/**
 * Obtiene las estadísticas comparativas de Alcaldías para el Dashboard
 * @param {string} alcaldiaName - Nombre de la alcaldía
 */
export async function fetchBoroughStats(alcaldiaName) {
  try {
    const [geojson, markets] = await Promise.all([
      fetchEstablishmentsLayer(),
      fetchMarketsLayer()
    ]);
    const boroughName = String(alcaldiaName || '').toLowerCase();
    const boroughFeatures = geojson.features.filter((f) => {
      const m = String(f?.properties?.municipio || '').toLowerCase();
      return m.includes(boroughName);
    });

    const totalEstablishments = boroughFeatures.length;
    const activeEmployees = boroughFeatures.reduce((acc, f) => {
      return acc + parseEmployees(f?.properties?.per_ocu || f?.properties?.employees);
    }, 0);
    const compliantCount = boroughFeatures.reduce((acc, f) => {
      const uso = String(f?.properties?.uso_de_suelo || '').trim();
      return acc + (uso ? 1 : 0);
    }, 0);

    const publicMarkets = markets.features.filter((f) => {
      const borough = String(f?.properties?.borough || '').toLowerCase();
      return borough.includes(boroughName);
    }).length;

    return {
      name: alcaldiaName,
      population: Math.max(60000, totalEstablishments * 12),
      totalEstablishments,
      publicMarkets,
      complianceRate: totalEstablishments > 0
        ? Number(((compliantCount / totalEstablishments) * 100).toFixed(1))
        : 0,
      activeEmployees
    };
  } catch (error) {
    console.warn('No se pudo calcular estadística por alcaldía desde backend.', error);
    return null;
  }
}

/**
 * Algoritmo geométrico: Determina si un punto [lng, lat] se encuentra dentro de un polígono
 * @param {Array} point - Coordenadas [longitud, latitud]
 * @param {Array} vs - Arreglo de vértices del polígono [[lng, lat], ...]
 */
function isPointInPolygon(point, vs) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Realiza una auditoría cruzada catastral en Go o JS
 * Cruza la coordenada de un comercio con los polígonos SEDUVI para validar uso de suelo
 * @param {number} lat - Latitud
 * @param {number} lng - Longitud
 * @param {string} businessSector - Giro/Sector comercial del negocio
 */
let zoningLayerCache = null;

async function getZoningLayer() {
  if (!zoningLayerCache) {
    zoningLayerCache = await fetchZoningLayer();
  }
  return zoningLayerCache;
}

export async function performLandUseAudit(lat, lng, businessSector) {
  const point = [lng, lat];
  let matchedZone = null;

  const zoning = await getZoningLayer();

  // Buscar en todos los polígonos de SEDUVI
  for (const feature of zoning.features) {
    // Los polígonos GeoJSON tienen las coordenadas en feature.geometry.coordinates[0]
    const polygonVertices = feature.geometry.coordinates[0];
    
    if (isPointInPolygon(point, polygonVertices)) {
      matchedZone = feature.properties;
      break;
    }
  }

  // Veredicto final
  if (matchedZone) {
    // Comprobar si el sector comercial está en la lista de permitidos
    const isAllowed = matchedZone.allowedSectors.includes(businessSector);
    
    return {
      compliant: isAllowed,
      zoneId: matchedZone.id,
      zoneName: matchedZone.name,
      zoningCode: matchedZone.typeLabel,
      zoningDescription: matchedZone.description,
      allowedSectors: matchedZone.allowedSectors,
      reason: isAllowed 
        ? `El giro '${businessSector}' cumple con las normativas aprobadas para esta zona mixta/comercial.` 
        : `Inconsistencia: El giro '${businessSector}' no está autorizado en esta zona residencial o de preservación.`
    };
  }

  // Fuera de polígonos catalogados en la demo (Zonificación General de la Ciudad)
  return {
    compliant: true,
    zoneId: 'general',
    zoneName: 'Zonificación General CDMX',
    zoningCode: 'Uso Mixto General (Z-1)',
    zoningDescription: 'Zonificación catastral generalizada para el comercio local y servicios de bajo impacto urbano.',
    allowedSectors: ['Comercio', 'Servicios', 'Alimentos'],
    reason: 'Establecimiento ubicado en zona de uso mixto generalizado. Sin inconsistencias registradas.'
  };
}

/**
 * Llama al endpoint de Dictamen de Uso de Suelo para un establecimiento.
 * @param {string} uuid - UUID del establecimiento
 * @returns {Promise<Object|null>}
 */
export async function fetchDictamenUsoDeSuelo(uuid) {
  if (!uuid || uuid.startsWith('api_est_')) return null;
  try {
    return await fetchJSON(`${API_BASE}/dictamen-uso-de-suelo?uuid=${encodeURIComponent(uuid)}`);
  } catch (error) {
    console.warn('No se pudo obtener el dictamen de uso de suelo:', error);
    return null;
  }
}
