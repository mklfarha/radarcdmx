import {
  fetchMarketsLayer,
  fetchEstablishmentsNearbyLayer,
  fetchBoroughStats,
  fetchCompareMunicipios,
  fetchSectoresCatalog,
  fetchActividadesCatalog,
  fetchMunicipiosCatalog,
  fetchUsosDeSueloCatalog,
  performLandUseAudit,
  fetchDictamenUsoDeSuelo
} from './api.js';

// --- CONFIGURACIÓN DE TOKENS (MAPBOX OPTIONAL FALLBACK) ---
const DEFAULT_PUBLIC_TOKEN = '';
let mapboxToken = localStorage.getItem('mapbox_token') || '';

// --- VARIABLES DE ESTADO GLOBAL ---
let map = null;
let currentMarker = null;
let currentChart = null;
let auditHistory = JSON.parse(localStorage.getItem('radar_history')) || [];
let dynamicSectorCatalog = null;
let currentActividadOptions = [];
let uploadedGeoJSON = null;

// --- ELEMENTOS DE LA INTERFAZ DE USUARIO ---
const elBtnSettings = document.getElementById('btn-settings');
const elModalSettings = document.getElementById('modal-settings');
const elBtnCloseSettings = document.getElementById('btn-close-settings');
const elInputToken = document.getElementById('mapbox-token-input');
const elBtnSaveToken = document.getElementById('btn-save-token');
const elBtnClearToken = document.getElementById('btn-clear-token');

const elHudLat = document.getElementById('hud-lat');
const elHudLng = document.getElementById('hud-lng');
const elHudZoom = document.getElementById('hud-zoom');

// Indicador de carga de datos del mapa
const elMapLoading = document.getElementById('map-loading');
// Contador para soportar cargas concurrentes/solapadas sin parpadeo.
let mapLoadingCount = 0;

function showMapLoading() {
  mapLoadingCount += 1;
  if (elMapLoading) elMapLoading.hidden = false;
}

function hideMapLoading() {
  mapLoadingCount = Math.max(0, mapLoadingCount - 1);
  if (mapLoadingCount === 0 && elMapLoading) {
    elMapLoading.hidden = true;
  }
}

// Filtros de Búsqueda (HUD)
const elFilterAlcaldia = document.getElementById('filter-alcaldia');
const elFilterSector = document.getElementById('filter-sector');
const elFilterSectorDesc = document.getElementById('filter-sector-desc');
const elFilterActividad = document.getElementById('filter-actividad');
const elFilterActividadDesc = document.getElementById('filter-actividad-desc');
const elFilterSuelo = document.getElementById('filter-suelo');

// Cargador de CSV
const elDropZone = document.getElementById('csv-drop-zone');
const elFileInput = document.getElementById('csv-file-input');
const elUploaderStatus = document.getElementById('uploader-status');
const elUploaderStatusText = document.getElementById('uploader-status-text');

// Comparador de Alcaldías
const elCompareSelectA = document.getElementById('compare-a');
const elCompareSelectB = document.getElementById('compare-b');

// Estados del Sidebar
const panelEmpty = document.getElementById('panel-empty');
const panelLoading = document.getElementById('panel-loading');
const panelReport = document.getElementById('panel-report');

// Pasos de Carga
const stepCoords = document.getElementById('step-coords');
const stepGeocoding = document.getElementById('step-geocoding');
const stepWeather = document.getElementById('step-weather');
const stepMetrics = document.getElementById('step-metrics');

// Campos del Reporte
const elReportCompanyName = document.getElementById('report-company-name');
const elReportCompanyRfc = document.getElementById('report-company-rfc');
const elReportCompanyZone = document.getElementById('report-company-zone');
const elReportSector = document.getElementById('report-sector');
const elReportEmployees = document.getElementById('report-employees');
const elReportFounded = document.getElementById('report-founded');
const elReportAddress = document.getElementById('report-address');
const elReportStatusFiscal = document.getElementById('report-status-fiscal');
const elStatusFiscalIcon = document.getElementById('status-fiscal-icon');

// Auditoría de Suelo
const elAuditVerdictBadge = document.getElementById('audit-verdict-badge');
const elAuditVerdictProgress = document.getElementById('audit-verdict-progress');
const elReportZoningType = document.getElementById('report-zoning-type');
const elComplianceAlertsList = document.getElementById('compliance-alerts-list');

// Rentabilidad
const elReportRevenue = document.getElementById('report-revenue');
const elReportMargin = document.getElementById('report-margin');

// Botones de Acción e Historial
const elBtnExportJson = document.getElementById('btn-export-json');
const elBtnResetMap = document.getElementById('btn-reset-map');
const elHistoryItems = document.getElementById('history-items');
const elCloseSidebarBtn = document.getElementById('close-sidebar-btn');
const elDashboardSidebar = document.getElementById('dashboard-sidebar');

// Elementos de UI Móvil adicionales
const elLeftHudPanel = document.getElementById('left-hud-panel');
const elCloseHudBtn = document.getElementById('close-hud-btn');
const elBtnMobileFilters = document.getElementById('btn-mobile-filters');
const elBtnMobileSidebar = document.getElementById('btn-mobile-sidebar');

// Elementos de Buscador Inteligente
const elSearchInput = document.getElementById('search-input');
const elSearchResultsDropdown = document.getElementById('search-results-dropdown');

// Botón de regresar al dashboard
const elBtnBackToDashboard = document.getElementById('btn-back-to-dashboard');

let lastAuditData = null; // Guardará el último reporte generado

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', async () => {
  // Cada paso de inicialización se aísla para que un fallo (p.ej. un elemento
  // del DOM ausente) no impida la carga del resto, en particular el llenado de
  // los filtros desde el backend.
  const initStep = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      console.error(`Error en inicialización (${label}):`, error);
      return undefined;
    }
  };

  initStep('iconos', () => lucide.createIcons());

  initStep('token', () => {
    const savedToken = localStorage.getItem('mapbox_token');
    if (savedToken && elInputToken) {
      elInputToken.value = savedToken;
    }
  });

  initStep('mapa', () => initMap());
  initStep('responsivo-movil', () => {
    if (window.innerWidth <= 768) {
      elDashboardSidebar?.classList.add('collapsed');
      elLeftHudPanel?.classList.add('collapsed');
    }
  });
  initStep('comparador', () => updateBoroughComparison());
  initStep('eventos', () => registerEventListeners());

  // Cargar catálogos backend para sectores/actividades con fallback local
  try {
    await bootstrapBackendFilters();
  } catch (error) {
    console.error('Error al cargar catálogos de filtros:', error);
  }
});

// --- CAPAS Y MAPA ---
function getStyleConfig(styleName, token) {
  const hasValidToken = token && token.trim().startsWith('pk.') && token !== DEFAULT_PUBLIC_TOKEN;
  
  if (hasValidToken) {
    // Si hay token Mapbox
    if (styleName === 'light') return `https://api.mapbox.com/styles/v1/mapbox/light-v11?access_token=${token}`;
    if (styleName === 'streets') return `https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=${token}`;
    return `https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=${token}`;
  } else {
    // Capas base gratuitas de CartoDB (no requieren token de acceso)
    let tileUrl = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'; // Dark Matter sin {r}
    let attribution = '© OpenStreetMap contributors, © CartoDB';
    
    if (styleName === 'light') {
      tileUrl = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'; // Positron sin {r}
    } else if (styleName === 'streets') {
      tileUrl = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'; // Voyager sin {r}
    }
    
    return {
      version: 8,
      sources: {
        'raster-tiles': {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          attribution: attribution
        }
      },
      layers: [
        {
          id: 'raster-layer',
          type: 'raster',
          source: 'raster-tiles',
          minzoom: 0,
          maxzoom: 20
        }
      ]
    };
  }
}

async function initMap() {
  if (mapboxToken) {
    maplibregl.accessToken = mapboxToken;
  }
  
  const cdmxCenter = [-99.155, 19.420];
  const defaultZoom = 11.8;

  try {
    map = new maplibregl.Map({
      container: 'map',
      style: getStyleConfig('light', mapboxToken),
      center: cdmxCenter,
      zoom: defaultZoom,
      pitch: 15
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');

    map.on('mousemove', (e) => {
      elHudLat.textContent = e.lngLat.lat.toFixed(5);
      elHudLng.textContent = e.lngLat.lng.toFixed(5);
    });

    map.on('zoom', () => {
      elHudZoom.textContent = map.getZoom().toFixed(1);
    });

    // Cargar las Capas GeoJSON al iniciar el mapa
    map.on('load', async () => {
      await loadMapLayers();
    });

  } catch (error) {
    console.error('Error al iniciar MapLibre:', error);
  }
}

async function loadMapLayers() {
  showMapLoading();
  try {
    // 1. OBTENER DATOS DE LAS CAPAS (De nuestro resolvedor local)
    const marketsGeoJSON = await fetchMarketsLayer();
    const establishmentsGeoJSON = await fetchEstablishmentsViewport();

    // 2. AÑADIR FUENTES AL MAPA
    map.addSource('markets-source', {
      type: 'geojson',
      data: marketsGeoJSON
    });

    map.addSource('establishments-source', {
      type: 'geojson',
      data: establishmentsGeoJSON
    });

    // Fuente vacía para archivos subidos por el usuario
    map.addSource('uploaded-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // 3. AÑADIR CAPAS AL MAPA
    // B. Capa de Mercados Públicos (Pines Verdes)
    map.addLayer({
      id: 'markets-layer',
      type: 'circle',
      source: 'markets-source',
      layout: {
        'visibility': 'visible'
      },
      paint: {
        'circle-radius': 7,
        'circle-color': '#10b981',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });

    // C. Capa de Comercios DENUE (Pines de color según Estatus/Giro)
    map.addLayer({
      id: 'establishments-layer',
      type: 'circle',
      source: 'establishments-source',
      layout: {
        'visibility': 'visible'
      },
      paint: {
        'circle-radius': 6,
        'circle-color': '#802A95',        
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 1
      }
    });

    // D. Capa de Datos Cargados por el usuario
    map.addLayer({
      id: 'uploaded-layer',
      type: 'circle',
      source: 'uploaded-source',
      layout: {
        'visibility': 'none'
      },
      paint: {
        'circle-radius': 6.5,
        'circle-color': '#eab308', // Dorado
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });

    // 4. CONFIGURAR INTERACCIONES (CLIC EN PUNTOS)
    configureMapInteractions();

    // 5. RECARGAR ESTABLECIMIENTOS AL MOVER EL MAPA
    let moveEndTimer = null;
    map.on('moveend', () => {
      clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(() => applyFilters(), 400);
    });

  } catch (error) {
    console.error('Error cargando las capas geográficas:', error);
  } finally {
    hideMapLoading();
  }
}

/**
 * Carga los establecimientos visibles en el viewport actual del mapa.
 */
async function fetchEstablishmentsViewport() {
  const center = map.getCenter();
  try {
    return await fetchEstablishmentsNearbyLayer({
      lat: center.lat,
      lng: center.lng,
      bbox: getViewportBBox()
    });
  } catch (error) {
    console.warn('No se pudo cargar establecimientos del viewport:', error);
    return { type: 'FeatureCollection', features: [] };
  }
}

/**
 * Devuelve la caja delimitadora (bounding box) del viewport actual del mapa,
 * lista para enviarse al endpoint /nearby en modo rectángulo.
 */
function getViewportBBox() {
  const bounds = map.getBounds();
  return {
    minLat: bounds.getSouth(),
    maxLat: bounds.getNorth(),
    minLng: bounds.getWest(),
    maxLng: bounds.getEast()
  };
}

function configureMapInteractions() {
  const pointerLayers = ['establishments-layer', 'markets-layer', 'uploaded-layer'];
  
  // Cambiar cursor a pointer al pasar sobre los puntos
  pointerLayers.forEach(layerId => {
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  });

  // Evento Clic en Capa DENUE
  map.on('click', 'establishments-layer', (e) => {
    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates;
    triggerComplianceAudit(coords[1], coords[0], props);
  });

  // Evento Clic en Capa Mercados
  map.on('click', 'markets-layer', (e) => {
    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates;
    
    // Adaptar formato comercial para los mercados
    const marketProps = {
      name: props.name,
      rfc: 'PÚBLICO-CDMX-' + props.id.substring(7, 10),
      sector: 'Comercio / Abasto',
      employees: props.stalls,
      founded: props.founded,
      fiscalStatus: 'Activa',
      zone: `${props.borough}, CDMX`
    };
    
    triggerComplianceAudit(coords[1], coords[0], marketProps);
  });

  // Evento Clic en Capa Cargada
  map.on('click', 'uploaded-layer', (e) => {
    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates;
    triggerComplianceAudit(coords[1], coords[0], props);
  });
}

// --- AUDITORÍA DE USO DE SUELO ---
async function triggerComplianceAudit(lat, lng, companyProps) {
  // Posicionar marcador visual
  if (currentMarker) currentMarker.remove();

  const markerEl = document.createElement('div');
  markerEl.className = 'custom-marker';
  markerEl.innerHTML = '<div class="marker-pulse"></div><div class="marker-dot" style="background:var(--color-primary);"></div>';

  currentMarker = new maplibregl.Marker({ element: markerEl })
    .setLngLat([lng, lat])
    .addTo(map);

  map.flyTo({
    center: [lng, lat],
    zoom: 15.5,
    essential: true,
    duration: 1000
  });

  elDashboardSidebar.classList.remove('collapsed');

  // Mostrar Loading
  switchStatePanel('loading');
  resetLoadingSteps();

  setStepState(stepCoords, 'done');
  setStepState(stepGeocoding, 'loading');

  try {
    await delay(80);
    setStepState(stepGeocoding, 'done');
    setStepState(stepWeather, 'loading');

    await delay(80);
    setStepState(stepWeather, 'done');
    setStepState(stepMetrics, 'loading');

    // Realizar la auditoría cruzada de uso de suelo en JS local y dictamen real
    const [auditReport, dictamen] = await Promise.all([
      performLandUseAudit(lat, lng, companyProps.sector),
      fetchDictamenUsoDeSuelo(companyProps.id)
    ]);
    
    await delay(80);
    setStepState(stepMetrics, 'done');
    await delay(40);

    // Combinar la información comercial y la de zonificación catastral
    const finalReport = {
      coordinates: { latitude: lat, longitude: lng },
      company: {
        nombre: companyProps.nombre || companyProps.name,
        clee: companyProps.clee || companyProps.rfc,
        nombre_actividad: companyProps.nombre_actividad || companyProps.sector,
        per_ocu: companyProps.per_ocu || companyProps.employees,
        fecha_alta: companyProps.fecha_alta || companyProps.founded,
        fiscalStatus: companyProps.fiscalStatus || 'Activa',
        municipio: companyProps.municipio || companyProps.zone || auditReport.zoneName,
        direccion: companyProps.direccion || ''
      },
      zoning: {
        code: companyProps.clave_catastral || auditReport.zoningCode,
        description: auditReport.zoningDescription,
        compliant: dictamen ? dictamen.aprobado : auditReport.compliant,
        reason: dictamen ? dictamen.razon : auditReport.reason,
        dictamen
      },
      profitability: generateMockProfitability(companyProps.employees || companyProps.per_ocu || 10, randomInRange(15, 30)),
      timestamp: new Date().toISOString()
    };

    // Renderizar Reporte
    renderReport(finalReport);

    // Guardar en Historial
    saveToHistory(finalReport);

    switchStatePanel('report');

  } catch (error) {
    console.error('Error en auditoría territorial:', error);
    switchStatePanel('empty');
    alert('Error al realizar el análisis del predio seleccionado.');
  }
}

function renderReport(data) {
  lastAuditData = data;

  elReportCompanyName.textContent = data.company.nombre || data.company.name || '';
  elReportCompanyRfc.textContent = data.company.clee || data.company.rfc || '';
  elReportCompanyZone.textContent = data.company.municipio || data.company.zone || '';

  elReportSector.textContent = data.company.nombre_actividad || data.company.sector || '';
  elReportEmployees.textContent = data.company.per_ocu || data.company.employees || '';
  elReportFounded.textContent = data.company.fecha_alta || data.company.founded || '';
  elReportAddress.textContent = data.company.direccion || '—';

  // Uso de suelo
  elReportZoningType.textContent = data.zoning.code;
  const coincide = data.zoning.compliant;
  elAuditVerdictBadge.textContent = coincide ? 'Coincide' : 'No coincide';
  elAuditVerdictBadge.className = `risk-badge ${coincide ? 'badge-low' : 'badge-high'}`;

  elAuditVerdictProgress.style.width = coincide ? '100%' : '35%';
  elAuditVerdictProgress.className = `progress-bar ${coincide ? '' : 'bg-high'}`;

  // Desplegar Dictamen en caja de alerta
  elComplianceAlertsList.innerHTML = '';
  const d = data.zoning.dictamen;
  const dictamenCard = document.createElement('div');
  dictamenCard.className = `dictamen-card ${coincide ? 's-ok' : 's-fail'}`;
  if (d) {
    dictamenCard.innerHTML = `
      <div class="dictamen-label">${coincide ? '<i data-lucide="check-circle"></i>' : '<i data-lucide="x-circle"></i>'} <strong>${coincide ? 'Uso de suelo compatible' : 'Uso de suelo incompatible'}</strong></div>
      <div class="dictamen-detail"><span class="dictamen-key">Uso de suelo:</span> ${d.uso_de_suelo || '—'}</div>
      <div class="dictamen-detail"><span class="dictamen-key">Sector económico:</span> ${d.sector || '—'}</div>
      <div class="dictamen-detail"><span class="dictamen-key">Código sector:</span> ${d.codigo_sector || '—'}</div>
      <div class="dictamen-reason">${d.razon || ''}</div>
    `;
  } else {
    dictamenCard.innerHTML = `<div class="dictamen-reason">${data.zoning.reason || ''}</div>`;
  }
  elComplianceAlertsList.appendChild(dictamenCard);
  if (d) lucide.createIcons({ nodes: [dictamenCard] });
}

// --- COMPARADOR TERRITORIAL ---
async function updateBoroughComparison() {
  const bA = elCompareSelectA.value;
  const bB = elCompareSelectB.value;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  // Establecimientos, empleados y desglose por sector provienen del backend
  // (datos reales). Población, mercados y cumplimiento siguen estimándose con
  // fetchBoroughStats mientras no existan endpoints dedicados.
  const [comparison, statsA, statsB] = await Promise.all([
    fetchCompareMunicipios(bA, bB),
    fetchBoroughStats(bA),
    fetchBoroughStats(bB)
  ]);

  const compareA = comparison?.[0] || null;
  const compareB = comparison?.[1] || null;

  // Población (estimada)
  if (statsA) setText('comp-val-pop-a', statsA.population.toLocaleString('es-MX'));
  if (statsB) setText('comp-val-pop-b', statsB.population.toLocaleString('es-MX'));

  // Establecimientos (reales si hay backend, si no fallback estimado)
  const estA = compareA ? compareA.total_establecimientos : statsA?.totalEstablishments;
  const estB = compareB ? compareB.total_establecimientos : statsB?.totalEstablishments;
  if (estA != null) setText('comp-val-est-a', Number(estA).toLocaleString('es-MX'));
  if (estB != null) setText('comp-val-est-b', Number(estB).toLocaleString('es-MX'));

  // Mercados (estimado)
  if (statsA) setText('comp-val-mkt-a', statsA.publicMarkets);
  if (statsB) setText('comp-val-mkt-b', statsB.publicMarkets);

  // Cumplimiento SEDUVI (estimado)
  if (statsA) setText('comp-val-comp-a', `${statsA.complianceRate}%`);
  if (statsB) setText('comp-val-comp-b', `${statsB.complianceRate}%`);

  // Trabajadores aproximados (reales si hay backend, si no fallback estimado)
  const empA = compareA ? compareA.empleados_aproximados : statsA?.activeEmployees;
  const empB = compareB ? compareB.empleados_aproximados : statsB?.activeEmployees;
  if (empA != null) setText('comp-val-emp-a', Number(empA).toLocaleString('es-MX'));
  if (empB != null) setText('comp-val-emp-b', Number(empB).toLocaleString('es-MX'));

  renderSectorComparison(compareA, compareB);
}

// Renderiza el desglose de establecimientos por sector para ambos municipios.
function renderSectorComparison(compareA, compareB) {
  const grid = document.getElementById('compare-sectors-grid');
  if (!grid) return;

  if (!compareA || !compareB) {
    grid.innerHTML = `
      <div class="compare-row">
        <div class="compare-col-lbl" style="grid-column: 1 / -1; text-align: center;">
          No se pudo cargar el desglose por sector.
        </div>
      </div>`;
    return;
  }

  // Unir los sectores de ambos municipios conservando un orden estable.
  const totalsA = new Map(compareA.sectores.map((s) => [s.sector, s.total]));
  const totalsB = new Map(compareB.sectores.map((s) => [s.sector, s.total]));

  const order = [];
  const seen = new Set();
  [...compareA.sectores, ...compareB.sectores].forEach((s) => {
    if (!seen.has(s.sector)) {
      seen.add(s.sector);
      order.push(s.sector);
    }
  });

  if (order.length === 0) {
    grid.innerHTML = `
      <div class="compare-row">
        <div class="compare-col-lbl" style="grid-column: 1 / -1; text-align: center;">
          Sin establecimientos registrados.
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = order.map((sector) => {
    const a = totalsA.get(sector) || 0;
    const b = totalsB.get(sector) || 0;
    const label = sector.length > 38 ? `${sector.slice(0, 38)}…` : sector;
    return `
      <div class="compare-row">
        <div class="compare-col-val">${a.toLocaleString('es-MX')}</div>
        <div class="compare-col-lbl" title="${sector}">${label}</div>
        <div class="compare-col-val">${b.toLocaleString('es-MX')}</div>
      </div>`;
  }).join('');
}

// --- CARGADOR DE CSV LOCAL (FRONTEND) ---
function handleCSVFileUpload(file) {
  if (!file) return;
  
  elUploaderStatus.style.display = 'flex';
  elUploaderStatus.innerHTML = '<i data-lucide="loader" class="animate-spin text-primary"></i><span>Procesando archivo...</span>';
  lucide.createIcons();

  const reader = new FileReader();
  
  reader.onload = function(e) {
    const text = e.target.result;
    
    try {
      const geojsonData = parseCSVToGeoJSON(text);
      
      if (geojsonData.features.length === 0) {
        throw new Error('No se encontraron coordenadas lat/lng válidas en el CSV.');
      }

      uploadedGeoJSON = geojsonData;

      // Actualizar capa en el mapa
      if (map) {
        map.getSource('uploaded-source').setData(geojsonData);
        map.setLayoutProperty('uploaded-layer', 'visibility', 'visible');
        
        // Ajustar mapa a los límites de los puntos cargados
        const coordinates = geojsonData.features.map(f => f.geometry.coordinates);
        const bounds = coordinates.reduce((acc, coord) => {
          return acc.extend(coord);
        }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
        
        map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
      }

      // Escribir estatus
      elUploaderStatus.className = 'uploader-status';
      elUploaderStatus.innerHTML = `
        <i data-lucide="check" class="text-low" style="width:16px; height:16px;"></i>
        <span class="text-low" style="font-weight:600;">¡Cargadas ${geojsonData.features.length} empresas con éxito!</span>
      `;
      lucide.createIcons();

    } catch (error) {
      console.error('Error al procesar el CSV:', error);
      elUploaderStatus.className = 'uploader-status alert-warning';
      elUploaderStatus.innerHTML = `
        <i data-lucide="alert-triangle" class="text-medium" style="width:16px; height:16px;"></i>
        <span class="text-medium" style="font-weight:600;">Error: ${error.message}</span>
      `;
      lucide.createIcons();
    }
  };

  reader.readAsText(file);
}

function parseCSVToGeoJSON(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return { type: 'FeatureCollection', features: [] };

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/gi, ''));
  const features = [];
  
  // Buscar índices de las columnas necesarias
  const latIdx = headers.findIndex(h => h.includes('lat') || h === 'y');
  const lngIdx = headers.findIndex(h => h.includes('lng') || h.includes('lon') || h === 'x');
  const nameIdx = headers.findIndex(h => h.includes('nom') || h.includes('raz') || h.includes('emp'));
  const sectorIdx = headers.findIndex(h => h.includes('gir') || h.includes('sec') || h.includes('act'));

  if (latIdx === -1 || lngIdx === -1) {
    throw new Error('Faltan columnas de geolocalización (latitud, longitud) en el encabezado.');
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parsear fila respetando posibles comillas en el CSV
    const row = parseCSVLine(line);
    
    const lat = parseFloat(row[latIdx]);
    const lng = parseFloat(row[lngIdx]);
    const name = nameIdx !== -1 && row[nameIdx] ? row[nameIdx].trim() : `Comercio Fila ${i}`;
    const sector = sectorIdx !== -1 && row[sectorIdx] ? row[sectorIdx].trim() : 'Comercio';

    if (!isNaN(lat) && !isNaN(lng)) {
      features.push({
        type: 'Feature',
        properties: {
          id: `upload_${i}`,
          name: name,
          rfc: 'RFC-CARGADO-' + Math.floor(100000 + Math.random() * 900000),
          sector: sector,
          employees: Math.floor(Math.random() * 25) + 3,
          founded: 2024,
          fiscalStatus: 'Activa',
          zone: 'Zona Importada (CSV)'
        },
        geometry: {
          type: 'Point',
          coordinates: [lng, lat]
        }
      });
    }
  }

  return { type: 'FeatureCollection', features: features };
}

// Helper para parsear líneas de CSV con soporte para comillas
function parseCSVLine(text) {
  let p = '', r = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    let c = text.charAt(i);
    if (c === '"') {
      q = !q;
    } else if (c === ',' && !q) {
      r.push(p);
      p = '';
    } else {
      p += c;
    }
  }
  r.push(p);
  return r;
}

// --- SISTEMA DE GRÁFICOS (CHART.JS) ---
function renderFinancialChart(quarters) {
  if (currentChart) {
    currentChart.destroy();
  }

  const ctx = document.getElementById('coverChart').getContext('2d');
  
  const labels = quarters.map(q => q.quarter);
  const revenues = quarters.map(q => q.revenue);
  const expenses = quarters.map(q => q.expenses);

  currentChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Ingresos',
          data: revenues,
          backgroundColor: '#9F2241',
          borderColor: 'rgba(159, 34, 65, 0.4)',
          borderWidth: 1,
          borderRadius: 4
        },
        {
          label: 'Egresos',
          data: expenses,
          backgroundColor: '#d97706',
          borderColor: 'rgba(217, 119, 6, 0.4)',
          borderWidth: 1,
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#7A6266',
            font: { family: 'Outfit', size: 10 }
          }
        },
        y: {
          grid: { color: 'rgba(159, 34, 65, 0.08)' },
          ticks: {
            color: '#7A6266',
            font: { family: 'Outfit', size: 9 },
            callback: function(value) {
              if (value >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
              if (value >= 1e3) return '$' + (value / 1e3).toFixed(0) + 'k';
              return '$' + value;
            }
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#2C1619',
            font: { family: 'Outfit', size: 11 },
            boxWidth: 12
          }
        }
      }
    }
  });
}

// --- HISTORIAL DE CONSULTAS ---
function saveToHistory(report) {
  const rfcVal = report.company.clee || report.company.rfc;
  // Filtrar duplicados
  auditHistory = auditHistory.filter(item => (item.clee || item.rfc) !== rfcVal);

  auditHistory.unshift({
    nombre: report.company.nombre || report.company.name,
    clee: rfcVal,
    municipio: (report.company.municipio || report.company.zone).split(',')[0],
    compliant: report.zoning.compliant,
    coordinates: report.coordinates
  });

  if (auditHistory.length > 8) {
    auditHistory.pop();
  }

  localStorage.setItem('radar_history', JSON.stringify(auditHistory));
  
}


// --- EVENT LISTENERS ---
function registerEventListeners() {
  // Modal de Configuración
  elBtnSettings?.addEventListener('click', () => elModalSettings.classList.add('active'));
  elBtnCloseSettings.addEventListener('click', () => elModalSettings.classList.remove('active'));
  elModalSettings.addEventListener('click', (e) => {
    if (e.target === elModalSettings) elModalSettings.classList.remove('active');
  });

  elBtnSaveToken.addEventListener('click', () => {
    const val = elInputToken.value.trim();
    if (!val) return alert('Ingresa una clave válida.');
    localStorage.setItem('mapbox_token', val);
    mapboxToken = val;
    elModalSettings.classList.remove('active');
    if (confirm('Token de Mapbox guardado. ¿Recargar página para activar mapas oficiales?')) {
      window.location.reload();
    }
  });

  elBtnClearToken.addEventListener('click', () => {
    localStorage.removeItem('mapbox_token');
    elInputToken.value = '';
    mapboxToken = '';
    elModalSettings.classList.remove('active');
    if (confirm('Token eliminado. Se utilizará la capa base libre de CartoDB. ¿Recargar ahora?')) {
      window.location.reload();
    }
  });

  // Eventos de Filtros de Búsqueda (recentran la cámara sobre los resultados)
  elFilterAlcaldia.addEventListener('change', () => applyFilters({ recenter: true }));
  elFilterSector.addEventListener('change', async () => {
    updateSectorDescription();
    await updateActividadDropdown();
    await applyFilters({ recenter: true });
  });
  elFilterActividad.addEventListener('change', () => {
    updateActividadDescription();
    applyFilters({ recenter: true });
  });
  elFilterSuelo.addEventListener('change', () => applyFilters({ recenter: true }));

  

  // Comparador territorial
  elCompareSelectA.addEventListener('change', updateBoroughComparison);
  elCompareSelectB.addEventListener('change', updateBoroughComparison);

  // Botón resetear mapa
  elBtnResetMap?.addEventListener('click', () => {
    if (currentMarker) {
      currentMarker.remove();
      currentMarker = null;
    }
    map.flyTo({
      center: [-99.155, 19.420],
      zoom: 11.8,
      pitch: 15,
      essential: true
    });
    switchStatePanel('empty');
  });

  // Exportar JSON del Reporte
  elBtnExportJson?.addEventListener('click', () => {
    if (!lastAuditData) return;
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(lastAuditData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `reporte_auditoria_${lastAuditData.company.rfc}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });
 

  elCloseSidebarBtn?.addEventListener('click', () => {
    elDashboardSidebar.classList.add('collapsed');
  });

  // Regresar al dashboard general (empty state)
  elBtnBackToDashboard?.addEventListener('click', () => {
    switchStatePanel('empty');
    if (currentMarker) {
      currentMarker.remove();
      currentMarker = null;
    }
    // Animación para regresar el mapa al zoom y centro original
    if (map) {
      map.flyTo({
        center: [-99.155, 19.420],
        zoom: 11.8,
        pitch: 15,
        essential: true,
        duration: 1000
      });
    }
  });

  // Clic en la "X" del panel de filtros móvil para cerrarlo
  elCloseHudBtn?.addEventListener('click', () => {
    elLeftHudPanel?.classList.add('collapsed');
  });

  // Botón flotante móvil para alternar filtros
  elBtnMobileFilters?.addEventListener('click', () => {
    elLeftHudPanel?.classList.toggle('collapsed');
    if (!elLeftHudPanel?.classList.contains('collapsed')) {
      elDashboardSidebar?.classList.add('collapsed'); // Cerrar el otro para evitar solapamientos
    }
  });

  // Botón flotante móvil para alternar dashboard
  elBtnMobileSidebar?.addEventListener('click', () => {
    elDashboardSidebar?.classList.toggle('collapsed');
    if (!elDashboardSidebar?.classList.contains('collapsed')) {
      elLeftHudPanel?.classList.add('collapsed'); // Cerrar el otro para evitar solapamientos
    }
  });

  // --- CARGADOR DE CSV (EVENT LISTENERS) ---
  // Clic en la zona de drop abre el selector de archivos
  elDropZone?.addEventListener('click', () => {
    elFileInput?.click();
  });

  // Cambio en el input de archivo
  elFileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleCSVFileUpload(file);
  });

  // Eventos de arrastrar y soltar
  elDropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    elDropZone.classList.add('dragover');
  });

  elDropZone?.addEventListener('dragleave', () => {
    elDropZone.classList.remove('dragover');
  });

  elDropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    elDropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleCSVFileUpload(file);
  });

  // Búsqueda inteligente
  let searchDebounceTimer = null;
  elSearchInput?.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    const queryText = e.target.value.trim();
    if (!queryText) {
      if (elSearchResultsDropdown) {
        elSearchResultsDropdown.innerHTML = '';
        elSearchResultsDropdown.style.display = 'none';
      }
      return;
    }
    searchDebounceTimer = setTimeout(async () => {
      try {
        const center = map.getCenter();
        
        // Búsqueda en datos CSV cargados localmente
        let localFeatures = [];
        if (uploadedGeoJSON && uploadedGeoJSON.features) {
          const lowerQuery = queryText.toLowerCase();
          localFeatures = uploadedGeoJSON.features.filter(f => {
            const name = (f.properties.name || f.properties.nombre || '').toLowerCase();
            const sector = (f.properties.sector || f.properties.nombre_actividad || '').toLowerCase();
            return name.includes(lowerQuery) || sector.includes(lowerQuery);
          });
        }

        // Búsqueda en la base de datos (Go backend)
        let backendFeatures = [];
        try {
          const results = await fetchEstablishmentsNearbyLayer({
            lat: center.lat,
            lng: center.lng,
            radiusM: 50000,
            q: queryText,
            pageSize: 5
          });
          backendFeatures = results?.features || [];
        } catch (backendErr) {
          console.warn('Error al buscar en backend:', backendErr);
        }

        // Combinar resultados
        const combined = [...localFeatures, ...backendFeatures].slice(0, 5);
        renderSearchResults(combined);
      } catch (err) {
        console.error('Error al realizar búsqueda inteligente:', err);
      }
    }, 300);
  });

  // Cerrar dropdown al hacer clic fuera del buscador o dropdown
  document.addEventListener('click', (e) => {
    if (elSearchResultsDropdown && elSearchInput && !elSearchInput.contains(e.target) && !elSearchResultsDropdown.contains(e.target)) {
      elSearchResultsDropdown.style.display = 'none';
    }
  });
}

function renderSearchResults(features) {
  if (!elSearchResultsDropdown) return;
  elSearchResultsDropdown.innerHTML = '';
  
  if (features.length === 0) {
    elSearchResultsDropdown.innerHTML = '<div class="search-no-results">No se encontraron resultados</div>';
    elSearchResultsDropdown.style.display = 'block';
    return;
  }
  
  features.forEach(feature => {
    const props = feature.properties;
    const coords = feature.geometry.coordinates;
    
    const itemEl = document.createElement('div');
    itemEl.className = 'search-result-item';
    itemEl.innerHTML = `
      <div class="search-result-name">${props.nombre || props.name}</div>
      <div class="search-result-desc">${props.nombre_actividad || props.sector || 'Establecimiento'} &bull; ${props.municipio || props.zone || ''}</div>
    `;
    
    itemEl.addEventListener('click', () => {
      if (elSearchInput) elSearchInput.value = '';
      elSearchResultsDropdown.style.display = 'none';
      
      // Mover cámara y disparar auditoría
      triggerComplianceAudit(coords[1], coords[0], props);
      
      // Colapsar paneles en móviles
      if (window.innerWidth <= 768) {
        elLeftHudPanel?.classList.add('collapsed');
      }
    });
    
    elSearchResultsDropdown.appendChild(itemEl);
  });
  
  elSearchResultsDropdown.style.display = 'block';
}

// --- UTILIDADES ---
function generateMockProfitability(employees, margin) {
  const annualRevenue = Math.round(employees * 500000 * (0.8 + Math.random() * 0.4));
  const quartersData = [];
  const seasonalFactors = [0.85, 0.95, 1.05, 1.15];
  
  for (let q = 0; q < 4; q++) {
    const qRevenue = Math.round((annualRevenue / 4) * seasonalFactors[q] * (0.92 + Math.random() * 0.16));
    const qExpenses = Math.round(qRevenue * (1 - (margin / 100) + (Math.random() * 0.05 - 0.025)));
    quartersData.push({
      quarter: `Q${q+1}-25`,
      revenue: qRevenue,
      expenses: qExpenses,
      profit: qRevenue - qExpenses
    });
  }
  
  return {
    annualRevenue: annualRevenue,
    margin: margin,
    quarters: quartersData
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInRange = (min, max) => parseFloat((min + Math.random() * (max - min)).toFixed(1));

// --- PANEL STATE & STEPS HELPERS ---
function switchStatePanel(state) {
  panelEmpty.classList.remove('active');
  panelLoading.classList.remove('active');
  panelReport.classList.remove('active');
  
  if (state === 'empty') {
    panelEmpty.classList.add('active');
  } else if (state === 'loading') {
    panelLoading.classList.add('active');
  } else if (state === 'report') {
    panelReport.classList.add('active');
  }
}

function resetLoadingSteps() {
  setStepState(stepCoords, 'pending');
  setStepState(stepGeocoding, 'pending');
  setStepState(stepWeather, 'pending');
  setStepState(stepMetrics, 'pending');
}

function setStepState(stepElement, state) {
  stepElement.className = `step-item ${state}`;
  const span = stepElement.querySelector('span');
  const text = span ? span.textContent : '';
  let iconHTML = '';
  
  if (state === 'pending') {
    iconHTML = '<i data-lucide="circle" class="step-dot"></i>';
  } else if (state === 'loading') {
    iconHTML = '<i data-lucide="loader" class="step-loader animate-spin"></i>';
  } else if (state === 'done') {
    iconHTML = '<i data-lucide="check-circle" class="step-check"></i>';
  }
  
  stepElement.innerHTML = `${iconHTML}<span>${text}</span>`;
  lucide.createIcons();
}

// --- CONSTANTES DE FILTRADO ---
const SCIAN_SECTORS = {
  'Todos': {
    short: 'Todos los Sectores',
    full: 'Todos los sectores económicos registrados.'
  },
  '11': {
    short: '11 - Agropecuario y Pesca',
    full: 'Agricultura, cría y explotación de animales, aprovechamiento forestal, pesca y caza.'
  },
  '21': {
    short: '21 - Minería',
    full: 'Minería.'
  },
  '22': {
    short: '22 - Energía, Agua y Gas',
    full: 'Generación, transmisión, distribución y comercialización de energía eléctrica, suministro de agua y de gas natural por ductos al consumidor final.'
  },
  '23': {
    short: '23 - Construcción',
    full: 'Construcción.'
  },
  '31-33': {
    short: '31-33 - Manufacturas',
    full: 'Industrias manufactureras.'
  },
  '43': {
    short: '43 - Comercio Mayorista',
    full: 'Comercio al por mayor.'
  },
  '46': {
    short: '46 - Comercio Minorista',
    full: 'Comercio al por menor.'
  },
  '48-49': {
    short: '48-49 - Transporte y Almacenamiento',
    full: 'Transportes, correos y almacenamiento.'
  },
  '51': {
    short: '51 - Medios e Información',
    full: 'Información en medios masivos.'
  },
  '52': {
    short: '52 - Financiero y Seguros',
    full: 'Servicios financieros y de seguros.'
  },
  '53': {
    short: '53 - Inmobiliario y Alquiler',
    full: 'Servicios inmobiliarios y de alquiler de bienes muebles e intangibles.'
  },
  '54': {
    short: '54 - Científico y Técnico',
    full: 'Servicios profesionales, científicos y técnicos.'
  },
  '55': {
    short: '55 - Corporativos',
    full: 'Dirección y administración de grupos empresariales o corporativos.'
  },
  '56': {
    short: '56 - Servicios de Apoyo',
    full: 'Servicios de apoyo a los negocios y manejo de residuos, y servicios de remediación.'
  },
  '61': {
    short: '61 - Servicios Educativos',
    full: 'Servicios educativos.'
  },
  '62': {
    short: '62 - Salud y Asistencia',
    full: 'Servicios de salud y de asistencia social.'
  },
  '71': {
    short: '71 - Recreación y Cultura',
    full: 'Servicios de esparcimiento, culturales y deportivos, y otros servicios recreativos.'
  },
  '72': {
    short: '72 - Hospedaje y Alimentos',
    full: 'Servicios de alojamiento temporal y de preparación de alimentos y bebidas.'
  },
  '81': {
    short: '81 - Otros Servicios',
    full: 'Otros servicios excepto actividades gubernamentales.'
  },
  '93': {
    short: '93 - Gobiernos y Org.',
    full: 'Actividades legislativas, gubernamentales, de impartición de justicia y de organismos internacionales y extraterritoriales.'
  }
};

const SECTOR_ACTIVITIES = {
  '11': [
    { code: '111110', name: 'Cultivo de granos y semillas' },
    { code: '112110', name: 'Cría y engorda de ganado bovino' }
  ],
  '21': [
    { code: '212230', name: 'Minería de cobre y níquel' }
  ],
  '22': [
    { code: '221110', name: 'Generación de energía eléctrica' },
    { code: '221310', name: 'Captación y suministro de agua' }
  ],
  '23': [
    { code: '236110', name: 'Edificación residencial' },
    { code: '237310', name: 'Construcción de vías de comunicación' }
  ],
  '31-33': [
    { code: '331111', name: 'Manufactura y talleres metálicos' }
  ],
  '43': [
    { code: '431110', name: 'Comercio al por mayor de abarrotes' }
  ],
  '46': [
    { code: '462110', name: 'Supermercados y tiendas de autoservicio' },
    { code: '465910', name: 'Comercio al por menor de artículos de vestir' }
  ],
  '48-49': [
    { code: '493110', name: 'Almacenaje y logística de bodegas' }
  ],
  '51': [
    { code: '512110', name: 'Producción de películas y videos' }
  ],
  '52': [
    { code: '522110', name: 'Banca múltiple e instituciones de crédito' }
  ],
  '53': [
    { code: '531110', name: 'Alquiler de oficinas y locales comerciales' }
  ],
  '54': [
    { code: '541110', name: 'Servicios de consultoría y despachos' }
  ],
  '55': [
    { code: '551111', name: 'Oficinas de administración de empresas' }
  ],
  '56': [
    { code: '561422', name: 'Servicios de call center y soporte' }
  ],
  '61': [
    { code: '611110', name: 'Escuelas de nivel básico y medio' }
  ],
  '62': [
    { code: '621111', name: 'Consultorios médicos privados' }
  ],
  '71': [
    { code: '713990', name: 'Clubes deportivos y gimnasios' }
  ],
  '72': [
    { code: '722511', name: 'Restaurantes con servicio de preparación' },
    { code: '722513', name: 'Cafeterías y fuentes de sodas' },
    { code: '722412', name: 'Bares y Cantinas' }
  ],
  '81': [
    { code: '811111', name: 'Servicios industriales y talleres mecánicos' }
  ],
  '93': [
    { code: '931210', name: 'Administración pública en general' }
  ]
};

const ALCALDIA_CENTERS = {
  'Cuauhtémoc': [-99.155, 19.432],
  'Miguel Hidalgo': [-99.195, 19.430],
  'Álvaro Obregón': [-99.220, 19.340],
  'Azcapotzalco': [-99.175, 19.485],
  'Coyoacán': [-99.162, 19.350],
  'Venustiano Carranza': [-99.119, 19.425]
};

function sectorValueToPrefixes(sectorValue) {
  if (!sectorValue || sectorValue === 'Todos') {
    return [];
  }

  if (sectorValue.includes('-')) {
    const parts = sectorValue.split('-').map((p) => parseInt(p, 10));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] <= parts[1]) {
      const prefixes = [];
      for (let p = parts[0]; p <= parts[1]; p++) {
        prefixes.push(String(p).padStart(2, '0'));
      }
      return prefixes;
    }
  }

  return [sectorValue];
}

function normalizeSectorOption(item) {
  const rawCodes = Array.isArray(item?.codigo_sector)
    ? item.codigo_sector.map((c) => String(c).trim()).filter(Boolean)
    : [];

  if (rawCodes.length === 0) {
    return null;
  }

  const sortedCodes = [...rawCodes].sort();
  const value = sortedCodes.length > 1
    ? `${sortedCodes[0]}-${sortedCodes[sortedCodes.length - 1]}`
    : sortedCodes[0];

  return {
    value,
    label: `${value} - ${item?.sector || 'Sector'}`,
    description: item?.sector || 'Sector económico',
    prefixes: sortedCodes
  };
}

async function bootstrapMunicipios() {
  try {
    const municipios = await fetchMunicipiosCatalog();
    if (!Array.isArray(municipios) || municipios.length === 0) {
      return;
    }

    const sorted = [...municipios].sort((a, b) =>
      a.localeCompare(b, 'es', { sensitivity: 'base' })
    );

    // Filtro principal de alcaldía/municipio
    if (elFilterAlcaldia) {
      const previousValue = elFilterAlcaldia.value;
      let optionsHTML = '<option value="Todos">Todas las Alcaldías</option>';
      sorted.forEach((m) => {
        optionsHTML += `<option value="${m}">${m}</option>`;
      });
      elFilterAlcaldia.innerHTML = optionsHTML;
      if (previousValue && sorted.includes(previousValue)) {
        elFilterAlcaldia.value = previousValue;
      }
    }

    // Selectores del comparador territorial
    [elCompareSelectA, elCompareSelectB].forEach((select) => {
      if (!select) return;
      const previousValue = select.value;
      let optionsHTML = '';
      sorted.forEach((m) => {
        optionsHTML += `<option value="${m}">${m}</option>`;
      });
      select.innerHTML = optionsHTML;
      if (previousValue && sorted.includes(previousValue)) {
        select.value = previousValue;
      }
    });
  } catch (error) {
    console.warn('No se pudo inicializar catálogo de municipios desde backend.', error);
  }
}

// Descripciones de las categorías SEDUVI de uso de suelo (por prefijo alfabético).
const USO_DE_SUELO_LABELS = {
  H: 'Habitacional',
  HC: 'Habitacional con Comercio',
  HM: 'Habitacional Mixto',
  HO: 'Habitacional con Oficinas',
  I: 'Industrial / Logística',
  E: 'Equipamiento',
  CB: 'Centro de Barrio',
  AV: 'Áreas de Valor Ambiental',
  ANP: 'Área Natural Protegida'
};

function describeUsoDeSuelo(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;

  if (USO_DE_SUELO_LABELS[raw]) {
    return `${raw} - ${USO_DE_SUELO_LABELS[raw]}`;
  }

  // Extraer el prefijo alfabético inicial (p.ej. "HC-4-30" -> "HC").
  const prefixMatch = raw.match(/^[A-Za-z]+/);
  const prefix = prefixMatch ? prefixMatch[0].toUpperCase() : '';
  if (prefix && USO_DE_SUELO_LABELS[prefix]) {
    return `${raw} - ${USO_DE_SUELO_LABELS[prefix]}`;
  }

  return raw;
}

async function bootstrapUsosDeSuelo() {
  if (!elFilterSuelo) return;

  let sorted = [];
  try {
    const usos = await fetchUsosDeSueloCatalog();
    if (Array.isArray(usos)) {
      sorted = [...usos].sort((a, b) =>
        a.localeCompare(b, 'es', { sensitivity: 'base' })
      );
    }
  } catch (error) {
    console.warn('No se pudo inicializar catálogo de usos de suelo desde backend.', error);
  }

  const previousValue = elFilterSuelo.value;
  let optionsHTML = '<option value="Todos">Todos los Usos de Suelo</option>';
  sorted.forEach((u) => {
    optionsHTML += `<option value="${u}">${describeUsoDeSuelo(u)}</option>`;
  });
  elFilterSuelo.innerHTML = optionsHTML;
  if (previousValue && sorted.includes(previousValue)) {
    elFilterSuelo.value = previousValue;
  }
}

async function bootstrapBackendFilters() {
  await bootstrapMunicipios();
  await bootstrapUsosDeSuelo();

  try {
    const sectorItems = await fetchSectoresCatalog();
    const normalized = sectorItems
      .map(normalizeSectorOption)
      .filter(Boolean)
      .sort((a, b) => a.value.localeCompare(b.value));

    if (normalized.length > 0) {
      dynamicSectorCatalog = normalized;

      const previousValue = elFilterSector.value;
      let optionsHTML = '<option value="Todos">Todos los Sectores</option>';
      normalized.forEach((item) => {
        optionsHTML += `<option value="${item.value}">${item.label}</option>`;
      });
      elFilterSector.innerHTML = optionsHTML;

      if (previousValue && normalized.some((item) => item.value === previousValue)) {
        elFilterSector.value = previousValue;
      }
    }
  } catch (error) {
    console.warn('No se pudo inicializar catálogo de sectores desde backend.', error);
  }

  updateSectorDescription();
  await updateActividadDropdown();
}

// --- LOGICA DE FILTRADO INTERACTIVO ---
function updateSectorDescription() {
  const sector = elFilterSector.value;
  if (!elFilterSectorDesc) {
    return;
  }

  const dynamicInfo = dynamicSectorCatalog?.find((item) => item.value === sector);
  if (dynamicInfo) {
    elFilterSectorDesc.textContent = dynamicInfo.description;
    return;
  }

  const info = SCIAN_SECTORS[sector];
  if (info) {
    elFilterSectorDesc.textContent = info.full;
    return;
  }

  elFilterSectorDesc.textContent = 'Todos los sectores económicos registrados.';
}

function updateActividadDescription() {
  const code = elFilterActividad.value;
  if (code === 'Todos') {
    elFilterActividadDesc.textContent = 'Todas las clases de actividades registradas.';
    return;
  }
  
  const current = currentActividadOptions.find((act) => act.code === code);
  if (current && elFilterActividadDesc) {
    elFilterActividadDesc.textContent = current.name + '.';
    return;
  }

  // Buscar en todas las actividades de fallback
  let matchedActivity = null;
  for (const sec in SECTOR_ACTIVITIES) {
    const activities = SECTOR_ACTIVITIES[sec];
    const found = activities.find((a) => a.code === code);
    if (found) {
      matchedActivity = found;
      break;
    }
  }

  if (matchedActivity && elFilterActividadDesc) {
    elFilterActividadDesc.textContent = matchedActivity.name + '.';
  }
}

async function updateActividadDropdown() {
  const sector = elFilterSector.value;
  elFilterActividad.disabled = false;

  const prefixes = dynamicSectorCatalog
    ? (dynamicSectorCatalog.find((item) => item.value === sector)?.prefixes || sectorValueToPrefixes(sector))
    : sectorValueToPrefixes(sector);

  try {
    const backendItems = await fetchActividadesCatalog(prefixes);
    if (backendItems.length > 0) {
      currentActividadOptions = backendItems
        .map((item) => ({
          code: String(item.codigo_actividad),
          name: String(item.nombre_actividad || 'Actividad')
        }))
        .filter((item) => item.code && item.code !== 'null');

      let backendOptionsHTML = '<option value="Todos">Todas las Actividades</option>';
      currentActividadOptions.forEach((act) => {
        const label = act.name.length > 52 ? `${act.name.slice(0, 52)}...` : act.name;
        backendOptionsHTML += `<option value="${act.code}">${act.code} - ${label}</option>`;
      });

      elFilterActividad.innerHTML = backendOptionsHTML;
      updateActividadDescription();
      return;
    }
  } catch (error) {
    console.warn('No se pudo cargar actividades desde backend.', error);
  }

  currentActividadOptions = [];
  let optionsHTML = '<option value="Todos">Todas las Actividades</option>';
  
  if (sector === 'Todos') {
    for (const sec in SECTOR_ACTIVITIES) {
      const activities = SECTOR_ACTIVITIES[sec];
      activities.forEach(act => {
        optionsHTML += `<option value="${act.code}">${act.code} - ${act.name.substring(0, 30)}...</option>`;
      });
    }
  } else {
    const activities = SECTOR_ACTIVITIES[sector] || [];
    activities.forEach(act => {
      optionsHTML += `<option value="${act.code}">${act.code} - ${act.name.substring(0, 30)}...</option>`;
    });
  }
  
  elFilterActividad.innerHTML = optionsHTML;
  updateActividadDescription();
}

async function applyFilters({ recenter = false } = {}) {
  if (!map) return;

  const alcaldia = elFilterAlcaldia.value;
  const sector = elFilterSector.value;
  const actividad = elFilterActividad.value;
  const suelo = elFilterSuelo.value;

  // 1. Obtener los datos base de establecimientos en el área visible del mapa.
  //    Sin alcaldía usamos el rectángulo (bbox) del viewport para evitar el
  //    artefacto de "círculo" al recortar por page_size. Con una alcaldía
  //    elegida (que puede quedar fuera del viewport) centramos por radio.
  //    Delegamos al backend los filtros exactos (municipio, código de actividad
  //    y uso de suelo); el sector se afina del lado del cliente.
  const center = map.getCenter();
  const nearbyOpts = {
    lat: center.lat,
    lng: center.lng,
    municipio: alcaldia !== 'Todos' ? alcaldia : undefined,
    codigoActividad: actividad !== 'Todos' ? actividad : undefined,
    usoDeSuelo: suelo !== 'Todos' ? suelo : undefined
  };

  if (alcaldia !== 'Todos' && ALCALDIA_CENTERS[alcaldia]) {
    const [alcaldiaLng, alcaldiaLat] = ALCALDIA_CENTERS[alcaldia];
    nearbyOpts.lat = alcaldiaLat;
    nearbyOpts.lng = alcaldiaLng;
    nearbyOpts.radiusM = 6000;
  } else {
    nearbyOpts.bbox = getViewportBBox();
  }

  let baseEstablishments = { type: 'FeatureCollection', features: [] };
  showMapLoading();
  try {
    baseEstablishments = await fetchEstablishmentsNearbyLayer(nearbyOpts);
  } catch (error) {
    console.warn('No se pudo consultar establecimientos cercanos.', error);
  } finally {
    hideMapLoading();
  }

  // 2. Filtrar las características (features)
  let filteredFeatures = baseEstablishments.features.filter(feature => {
    const props = feature.properties;
    
    // Filtro por Alcaldía
    if (alcaldia !== 'Todos') {
      const matchAlcaldia = (props.municipio || props.zone || '').toLowerCase().includes(alcaldia.toLowerCase());
      if (!matchAlcaldia) return false;
    }

    // Filtro por Sector (SCIAN 2-digit prefix)
    if (sector !== 'Todos') {
      const codeStr = String(props.codigo_actividad || '');
      if (sector === '31-33') {
        const prefix = codeStr.substring(0, 2);
        if (prefix !== '31' && prefix !== '32' && prefix !== '33') return false;
      } else if (sector === '48-49') {
        const prefix = codeStr.substring(0, 2);
        if (prefix !== '48' && prefix !== '49') return false;
      } else {
        if (!codeStr.startsWith(sector)) return false;
      }
    }

    // Filtro por Actividad / Código
    if (actividad !== 'Todos') {
      const codeStr = String(props.codigo_actividad || '');
      if (codeStr !== actividad) return false;
    }

    // Filtro por Uso de Suelo
    if (suelo !== 'Todos') {
      if (props.uso_de_suelo && !props.uso_de_suelo.startsWith(suelo)) {
        return false;
      }
      
      let calculatedUso = '';
      if (props.id === 'est_1' || props.id === 'est_4') calculatedUso = 'HC';
      else if (props.id === 'est_2' || props.id === 'est_3') calculatedUso = 'H';
      else if (props.id === 'est_5') calculatedUso = 'I';
      else if (props.id === 'est_6') calculatedUso = 'E';

      if (calculatedUso && calculatedUso !== suelo) {
        return false;
      }
    }

    return true;
  });

  // 3. Actualizar la fuente del mapa
  const filteredGeoJSON = {
    type: 'FeatureCollection',
    features: filteredFeatures
  };
  map.getSource('establishments-source').setData(filteredGeoJSON);

  // 4. Desplazar el mapa (Pan/FlyTo) SOLO cuando un cambio de filtro lo solicita.
  //    El refresco disparado por 'moveend' nunca mueve la cámara: hacerlo
  //    provocaría un bucle (fitBounds -> moveend -> applyFilters -> fitBounds)
  //    que aleja el zoom de forma indefinida.
  if (!recenter) return;

  if (window.innerWidth <= 768) {
    elLeftHudPanel?.classList.add('collapsed');
  }

  if (filteredFeatures.length > 0) {
    const coordinates = filteredFeatures.map(f => f.geometry.coordinates);
    const bounds = coordinates.reduce((acc, coord) => {
      return acc.extend(coord);
    }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

    map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 1200 });
  } else if (alcaldia !== 'Todos' && ALCALDIA_CENTERS[alcaldia]) {
    map.flyTo({
      center: ALCALDIA_CENTERS[alcaldia],
      zoom: 12.5,
      essential: true,
      duration: 1200
    });
  }
}

// --- ACCORDION TOGGLE PARA PANEL DE CONTROL IZQUIERDO ---
window.toggleHudSection = function(sectionId) {
  const sections = ['filters', 'uploader'];
  sections.forEach(sec => {
    const el = document.getElementById(`hud-section-${sec}`);
    if (sec === sectionId) {
      el.classList.toggle('active');
    } else {
      el.classList.remove('active');
    }
  });
};


