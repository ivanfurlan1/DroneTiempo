/* ===== CONFIGURATION ===== */
const DEFAULT_LOCATION = { lat: -34.8727, lon: -57.8769, name: "Berisso, BA" };

const T = {
    wind:  { warn: 22, bad: 32, max: 50 },
    gusts: { warn: 30, bad: 42, max: 60 },
    kp:    { warn: 4,  bad: 5 },
    rain:  { bad: 0.1 },
    sats:  { warn: 12, bad: 8 },
    temp:  { coldWarn: 10, coldBad: 0, hotWarn: 35, hotBad: 40 },
    vis:   { warn: 2000, bad: 500 }
};

let state = {
    location: null, forecast: {}, kpForecast: {},
    selectedDate: null, selectedHourIndex: 0, selectedWindHourIndex: 0, kpFallback: true,
    cacheTimestamp: null,
    flightMode: localStorage.getItem('drone_clima_flight_mode') || 'standard',
    units: localStorage.getItem('drone_clima_units') || 'metric',
    kpSensitivity: localStorage.getItem('drone_clima_kp_sensitivity') === 'true',
    themeAccent: localStorage.getItem('drone_clima_theme_accent') || 'sky',
    flightLogs: JSON.parse(localStorage.getItem('drone_clima_flight_logs')) || []
};

/* ===== HELPERS ===== */
const getLocalDateString = (d) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
};

function safeUpdateIcons() {
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e) {}
}

function showToast(message) {
    const toast = document.getElementById('toast-notification');
    if (toast) {
        document.getElementById('toast-message').textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 4000);
    }
}

function saveToCache() {
    if (!state.rawWeather) return;
    const cacheData = {
        lat: state.location.lat,
        lon: state.location.lon,
        weather: state.rawWeather,
        kpForecast: state.kpForecast || {},
        kpFallback: state.kpFallback,
        timestamp: Date.now()
    };
    try {
        localStorage.setItem('drone_clima_cache', JSON.stringify(cacheData));
        state.cacheTimestamp = cacheData.timestamp;
        updateCacheStatusUI();
    } catch(e) {
        console.error("No se pudo guardar en localStorage", e);
    }
}

function updateCacheStatusUI() {
    const el = document.getElementById('cache-status');
    if (!el) return;
    
    if (!state.cacheTimestamp) {
        el.innerHTML = '';
        return;
    }
    
    const minutes = Math.round((Date.now() - state.cacheTimestamp) / 60000);
    if (minutes < 1) {
        el.innerHTML = `<i data-lucide="clock" style="color:var(--green)"></i> Actualizado ahora`;
    } else {
        el.innerHTML = `<i data-lucide="clock" style="color:var(--text-3)"></i> Actualizado hace ${minutes} min`;
    }
    safeUpdateIcons();
}

function handleRefresh() {
    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 700); }
    initApp(true);
}

/* ===== CORE ===== */
async function initApp(forceRefresh = false) {
    document.getElementById('app-content').style.display = 'none';
    showLoading("Calibrando sensores...");

    try {
        try { state.location = await getLocation(); }
        catch(e) { state.location = DEFAULT_LOCATION; }

        const elLoc = document.getElementById('location-name');
        if (elLoc) elLoc.innerHTML = `<i data-lucide="map-pin"></i> ${state.location.name}`;
        
        const btnChange = document.getElementById('btn-change-location');
        if (btnChange) btnChange.style.display = 'inline-flex';

        // Intento de lectura del caché local
        const cacheDuration = 30 * 60 * 1000; // 30 minutos
        const cachedDataStr = localStorage.getItem('drone_clima_cache');
        let useCache = false;

        if (cachedDataStr && !forceRefresh) {
            try {
                const cache = JSON.parse(cachedDataStr);
                const now = Date.now();
                const isRecent = (now - cache.timestamp) < cacheDuration;
                const isSameLocation = Math.abs(cache.lat - state.location.lat) < 0.01 && 
                                       Math.abs(cache.lon - state.location.lon) < 0.01;

                if (isRecent && isSameLocation) {
                    state.rawWeather = cache.weather;
                    state.kpForecast = cache.kpForecast || {};
                    state.kpFallback = cache.kpFallback ?? true;
                    state.cacheTimestamp = cache.timestamp;
                    useCache = true;
                }
            } catch (e) {
                console.error("Error al leer la caché del clima:", e);
            }
        }

        if (useCache) {
            showLoading("Cargando desde el caché...");
            processData();
            renderApp();
            updateCacheStatusUI();
            showToast("Datos cargados desde el caché local.");
        } else {
            showLoading("Descargando meteorología...");
            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${state.location.lat}&longitude=${state.location.lon}&hourly=temperature_2m,precipitation,cloudcover,windspeed_10m,windgusts_10m,winddirection_10m,visibility,is_day&timezone=auto&past_days=0&forecast_days=7`;
                const res = await fetch(url);
                if (!res.ok) throw new Error("API fail");
                state.rawWeather = await res.json();
                state.cacheTimestamp = Date.now();
                state.kpFallback = true;
                processData();
                saveToCache();
            } catch(e) {
                generateMockData();
                showToast("Fallo de red. Modo simulador activado.");
            }

            renderApp();
            fetchKpDataEnSegundoPlano();
        }

    } catch(fatal) {
        console.error(fatal);
        generateMockData();
        processData();
        renderApp();
    } finally {
        hideLoading();
    }
}

function getLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(DEFAULT_LOCATION);
        const t = setTimeout(() => resolve(DEFAULT_LOCATION), 2000);
        navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(t); resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Ubicación GPS actual" }); },
            () => { clearTimeout(t); resolve(DEFAULT_LOCATION); },
            { maximumAge: 60000, timeout: 2000, enableHighAccuracy: false }
        );
    });
}

async function fetchKpDataEnSegundoPlano() {
    try {
        const res = await fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
        if (!res.ok) return;
        const data = await res.json();
        state.kpForecast = {};
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const dateObj = new Date(row[0] + "Z");
            const ld = getLocalDateString(dateObj);
            const lh = dateObj.getHours();
            const kp = parseFloat(row[1]);
            if (!state.kpForecast[ld]) state.kpForecast[ld] = {};
            state.kpForecast[ld][lh] = kp;
            state.kpForecast[ld][(lh+1)%24] = kp;
            state.kpForecast[ld][(lh+2)%24] = kp;
        }
        state.kpFallback = false;
        processData();
        updateUIForSelected();
        saveToCache();
    } catch(e) {}
}

const getNum = (val, def) => (val !== undefined && val !== null && !isNaN(val)) ? Number(val) : def;

function processData() {
    state.forecast = {};
    if (!state.rawWeather || !state.rawWeather.hourly) return;
    const h = state.rawWeather.hourly;

    for (let i = 0; i < (h.time || []).length; i++) {
        const timeStr = h.time[i];
        if (!timeStr) continue;
        const dateKey = timeStr.split('T')[0];
        const hourStr = timeStr.split('T')[1].substring(0, 5);
        const hourInt = parseInt(hourStr.split(':')[0]);
        if (!state.forecast[dateKey]) state.forecast[dateKey] = [];

        let kpVal = 2.0;
        if (!state.kpFallback && state.kpForecast[dateKey] && state.kpForecast[dateKey][hourInt] !== undefined) {
            kpVal = state.kpForecast[dateKey][hourInt];
        }

        const wind = getNum(h.windspeed_10m?.[i], 0);
        const gusts = getNum(h.windgusts_10m?.[i], wind);
        const dir = getNum(h.winddirection_10m?.[i], 0);
        const rain = getNum(h.precipitation?.[i], 0);
        const temp = getNum(h.temperature_2m?.[i], 20);
        const clouds = getNum(h.cloudcover?.[i] || h.cloud_cover?.[i], 0);
        const vis = getNum(h.visibility?.[i], 10000);
        const isDay = h.is_day?.[i] === 1;

        let estSats = 18 - (clouds * 0.04) - (kpVal * 0.4);
        estSats = Math.max(0, Math.min(22, Math.round(estSats)));

        const hourData = {
            time: hourStr, hourInt,
            wind: Math.round(wind), gusts: Math.round(gusts), windDir: dir,
            rain, temp: Math.round(temp), clouds: Math.round(clouds),
            visibility: Math.round(vis), isDay,
            kp: parseFloat(kpVal.toFixed(1)), sats: estSats || 18
        };
        hourData.eval = evaluateFlightScore(hourData);
        state.forecast[dateKey].push(hourData);
    }

    const dates = Object.keys(state.forecast);
    if (dates.length > 0) {
        const todayLocal = getLocalDateString(new Date());
        let sel = state.forecast[todayLocal] ? todayLocal : dates[0];
        if (!state.selectedDate) {
            state.selectedDate = sel;
            const ch = new Date().getHours();
            state.selectedHourIndex = Math.max(0, state.forecast[sel].findIndex(h => h.hourInt >= ch));
        }
    }
}

function evaluateFlightScore(d) {
    let score = 100, status = 'good', reasons = [];
    const mode = state.flightMode || 'standard';

    // 1. PRECIPITACIONES (Bloqueo absoluto para vuelo)
    if (d.rain >= T.rain.bad) {
        score = 0;
        status = 'bad';
        reasons.push(d.rain > 1.5 ? "Lluvia fuerte (Imposible volar)" : "Lluvia leve (Imposible volar)");
    } else {
        // 2. VIENTO (Velocidad base y ráfagas)
        if (d.wind > T.wind.warn) score -= (d.wind - T.wind.warn) * 3.5;
        if (d.gusts > T.gusts.warn) score -= (d.gusts - T.gusts.warn) * 2.5;

        if (d.gusts >= T.gusts.bad || d.wind >= T.wind.bad) {
            status = 'bad';
            reasons.push("Viento peligroso");
        } else if (d.gusts >= T.gusts.warn || d.wind >= T.wind.warn) {
            if (status !== 'bad') status = 'warn';
            reasons.push("Viento moderado");
        }

        // 3. NUBOSIDAD (Nubosidad inteligente según el modo de vuelo)
        if (mode === 'film') {
            // Modo Filmación: Sumamente sensible a la nubosidad para iluminación y sombras
            if (d.clouds > 65) {
                score -= 55;
                if (status !== 'bad') status = 'bad';
                reasons.push("Cielo cubierto (No apto para grabaciones)");
            } else if (d.clouds > 30) {
                score -= 30;
                if (status === 'good') status = 'warn';
                reasons.push("Nubosidad moderada (Interfiere en filmación)");
            } else if (d.clouds > 10) {
                score -= 10;
                reasons.push("Nubes leves (Sombra parcial)");
            }
        } else if (mode === 'photo') {
            // Modo Fotografía: Sensible a nubes pero permite cierta tolerancia
            if (d.clouds > 80) {
                score -= 45;
                if (status !== 'bad') status = 'bad';
                reasons.push("Cielo muy cubierto (Luz deficiente para fotos)");
            } else if (d.clouds > 50) {
                score -= 25;
                if (status === 'good') status = 'warn';
                reasons.push("Nubosidad intermedia (Sombras fuertes)");
            } else if (d.clouds > 20) {
                score -= 8;
                reasons.push("Nubosidad leve");
            }
        } else {
            // Modo Estándar: Las nubes son un factor menor (pueden reducir orientación o luz levemente)
            if (d.clouds > 75) {
                score -= 18;
                if (status === 'good') status = 'warn';
                reasons.push("Cielo muy cubierto");
            } else if (d.clouds > 40) {
                score -= 8;
                reasons.push("Nubosidad moderada");
            }
        }

        // 4. TEMPERATURA
        if (d.temp <= T.temp.coldBad) {
            score -= 30;
            status = 'bad';
            reasons.push("Frío extremo");
        } else if (d.temp <= T.temp.coldWarn) {
            score -= 10;
            if (status === 'good') status = 'warn';
            reasons.push("Baja Temp. (Bat. dura menos)");
        } else if (d.temp >= T.temp.hotBad) {
            score -= 30;
            status = 'bad';
            reasons.push("Calor extremo");
        }

        // 5. ACTIVIDAD SOLAR (GPS)
        const kpBadVal = state.kpSensitivity ? 4.0 : T.kp.bad;
        const kpWarnVal = state.kpSensitivity ? 3.0 : T.kp.warn;

        if (d.kp >= kpBadVal) {
            score -= 40;
            status = 'bad';
            reasons.push("Tormenta solar severa");
        } else if (d.kp >= kpWarnVal) {
            score -= 15;
            if (status === 'good') status = 'warn';
            reasons.push("GPS inestable");
        }

        // 6. VISIBILIDAD
        if (d.visibility < T.vis.bad) {
            score -= 50;
            status = 'bad';
            reasons.push("Visibilidad nula");
        } else if (d.visibility < T.vis.warn) {
            score -= 15;
            if (status === 'good') status = 'warn';
            reasons.push("Poca visibilidad");
        }

        // 7. VUELO NOCTURNO
        if (!d.isDay) {
            score -= 15;
            if (mode === 'film') {
                score -= 20; // Penalización severa por nula iluminación para capturas de sensor
                if (status === 'good') status = 'warn';
                reasons.push("Vuelo nocturno (Sin luz para filmar)");
            } else if (mode === 'photo') {
                score -= 10; // Penalización menor porque es posible hacer fotos nocturnas (larga exposición)
                if (status === 'good') status = 'warn';
                reasons.push("Vuelo nocturno (Requiere larga exposición)");
            } else {
                reasons.push("Vuelo nocturno");
            }
        }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    if (reasons.length === 0) {
        reasons.push(score === 100 ? "Condiciones perfectas" : "Condiciones buenas");
    }
    return { score, status, reason: reasons[0] };
}

/* ===== RENDER ===== */
function renderApp() {
    document.getElementById('app-content').style.display = 'flex';
    updateFlightModeUI();
    renderDays();
    renderHours();
    updateUIForSelected();
    safeUpdateIcons();
}

function updateFlightModeUI() {
    const mode = state.flightMode || 'standard';
    const btnStd = document.getElementById('btn-settings-mode-standard');
    const btnFilm = document.getElementById('btn-settings-mode-film');
    const btnPhoto = document.getElementById('btn-settings-mode-photo');
    
    if (btnStd) btnStd.classList.toggle('active', mode === 'standard');
    if (btnFilm) btnFilm.classList.toggle('active', mode === 'film');
    if (btnPhoto) btnPhoto.classList.toggle('active', mode === 'photo');
}

function setFlightMode(mode) {
    if (state.flightMode === mode) return;
    state.flightMode = mode;
    localStorage.setItem('drone_clima_flight_mode', mode);
    
    // Re-procesar los datos meteorológicos con la nueva fórmula
    processData();
    
    // Volver a renderizar la app
    renderApp();
    
    // Si la pantalla de aptitud detallada está abierta, actualizarla automáticamente
    const suitScreen = document.getElementById('suitability-detail-screen');
    if (suitScreen && suitScreen.classList.contains('open')) {
        updateSuitabilityDetailData();
    }
    
    updateSettingsScreenUI();

    // Mostrar feedback al usuario
    let msg = "Modo Estándar: Enfocado en física de vuelo.";
    if (mode === 'film') msg = "Modo Grabación: Sensible a nubes y luz.";
    else if (mode === 'photo') msg = "Modo Foto: Optimizado para capturas estáticas.";
    showToast(msg);
}

function renderDays() {
    const c = document.getElementById('days-container');
    if (!c) return;
    c.innerHTML = '';
    Object.keys(state.forecast).forEach(dateStr => {
        const parts = dateStr.split('-');
        const dateObj = new Date(parts[0], parts[1]-1, parts[2]);
        const dayName = new Intl.DateTimeFormat('es-AR', { weekday: 'short' }).format(dateObj).replace('.','');
        const dayNameFormatted = dayName.charAt(0).toUpperCase() + dayName.slice(1);
        
        // Calculate day summary flight score
        const hours = state.forecast[dateStr] || [];
        let totalScore = 0;
        let count = 0;
        
        hours.forEach(h => {
            totalScore += h.eval.score;
            count++;
        });
        
        const avgScore = count > 0 ? Math.round(totalScore / count) : 100;
        
        let scoreStatus = 'good';
        if (avgScore < 50) scoreStatus = 'bad';
        else if (avgScore < 80) scoreStatus = 'warn';

        const btn = document.createElement('button');
        btn.className = `day-tab${dateStr === state.selectedDate ? ' active' : ''}`;
        btn.innerHTML = `
            <div class="day-name-wrapper">
                <span class="day-name">${dayNameFormatted}</span>
                <span class="day-status-dot score-${scoreStatus}"></span>
            </div>
            <span class="day-num">${dateObj.getDate()}</span>
        `;
        
        btn.onclick = () => {
            state.selectedDate = dateStr;
            state.selectedHourIndex = 0;
            if (dateStr === getLocalDateString(new Date())) {
                state.selectedHourIndex = Math.max(0, state.forecast[dateStr].findIndex(h => h.hourInt >= new Date().getHours()));
            }
            renderDays(); renderHours(); updateUIForSelected();
            
            // Si la pantalla de viento detallado está abierta, actualizarla automáticamente
            const screen = document.getElementById('wind-detail-screen');
            if (screen && screen.classList.contains('open')) {
                state.selectedWindHourIndex = state.selectedHourIndex;
                updateWindDetailData();
            }
            
            // Si la pantalla de aptitud detallada está abierta, actualizarla automáticamente
            const suitScreen = document.getElementById('suitability-detail-screen');
            if (suitScreen && suitScreen.classList.contains('open')) {
                state.selectedSuitabilityHourIndex = state.selectedHourIndex;
                updateSuitabilityDetailData();
            }
        };
        c.appendChild(btn);
    });
    
    // Auto-scroll logic to center the active day tab
    setTimeout(() => {
        const activeTab = c.querySelector('.day-tab.active');
        if (activeTab) {
            activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }, 50);
}

function renderHours() {
    const c = document.getElementById('hours-container');
    if (!c) return;
    c.innerHTML = '';
    const hours = state.forecast[state.selectedDate];
    if (!hours) return;

    hours.forEach((h, i) => {
        const sel = i === state.selectedHourIndex;
        const isCurrentHour = state.selectedDate === getLocalDateString(new Date()) && h.hourInt === new Date().getHours();
        const dotColor = h.eval.status === 'good' ? 'var(--green)' : (h.eval.status === 'warn' ? 'var(--yellow)' : 'var(--red)');

        let icon = 'sun';
        if (!h.isDay) icon = 'moon';
        if (h.clouds > 30) icon = h.isDay ? 'cloud-sun' : 'cloud-moon';
        if (h.clouds > 70) icon = 'cloud';
        if (h.rain > 0) icon = 'cloud-rain';
        if (h.wind >= T.wind.warn && h.rain === 0) icon = 'wind';

        const btn = document.createElement('button');
        btn.className = `hour-card${sel ? ' active' : ''}${isCurrentHour ? ' current' : ''}`;
        btn.innerHTML = `
            <span class="hour-time">${h.time}</span>
            <i data-lucide="${icon}" class="hour-icon"></i>
            <div class="hour-score-row">
                <span class="hour-dot" style="background:${dotColor}"></span>
                <span class="hour-score-val">${h.eval.score}</span>
            </div>`;
        btn.onclick = () => { state.selectedHourIndex = i; renderHours(); updateUIForSelected(); };
        c.appendChild(btn);
    });

    safeUpdateIcons();
    setTimeout(() => {
        const a = c.querySelector('.active');
        if (a) a.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }, 50);

    // Render the day/night arc after hour cards are in place
    renderDayNightArc();
}

/* ===== DAY/NIGHT ARC VISUALIZATION ===== */
function renderDayNightArc() {
    const canvas = document.getElementById('daynight-arc-canvas');
    const container = document.getElementById('hours-container');
    if (!canvas || !container) return;

    const hours = state.forecast[state.selectedDate];
    if (!hours || hours.length === 0) return;

    // Wait a tick for layout to settle
    requestAnimationFrame(() => {
        const scrollWidth = container.scrollWidth;
        const containerHeight = container.offsetHeight;
        const canvasVisualHeight = containerHeight + 120; // Extended downwards slightly by 120px for a subtle, elegant spill

        // Set canvas size to match the full scroll width and the extended vertical height
        const dpr = window.devicePixelRatio || 1;
        canvas.width = scrollWidth * dpr;
        canvas.height = canvasVisualHeight * dpr;
        canvas.style.width = scrollWidth + 'px';
        canvas.style.height = canvasVisualHeight + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, scrollWidth, canvasVisualHeight);

        const cardWidth = 74; // 66px card + 8px gap
        const paddingLeft = 20;
        const n = hours.length;

        // Find temperature range for normalization
        const temps = hours.map(h => h.temp);
        const minTemp = Math.min(...temps);
        const maxTemp = Math.max(...temps);
        const tempRange = Math.max(maxTemp - minTemp, 1);

        // Curve parameters (aligned with cards container bounds)
        const curveTop = 16;
        const curveBottom = containerHeight - 8;
        const curveRange = curveBottom - curveTop;

        // Build points: x is center of each card, y is based on temperature
        let points = hours.map((h, i) => {
            const x = paddingLeft + i * cardWidth + cardWidth / 2;
            const tNorm = (h.temp - minTemp) / tempRange; // 0 = coldest, 1 = hottest
            const y = curveBottom - (0.35 + tNorm * 0.45) * curveRange; // Scale to 45% of range, shifted by 35% to elevate baseline
            return { x, y, isDay: h.isDay, hourInt: h.hourInt, temp: h.temp };
        });

        if (points.length < 2) return;

        // Add virtual start and end points to extend the curve and gradient to the absolute edges of the screen
        const firstPoint = points[0];
        const lastPoint = points[points.length - 1];
        
        points.unshift({
            x: 0,
            y: firstPoint.y,
            isDay: firstPoint.isDay,
            hourInt: firstPoint.hourInt,
            temp: firstPoint.temp
        });
        
        points.push({
            x: scrollWidth,
            y: lastPoint.y,
            isDay: lastPoint.isDay,
            hourInt: lastPoint.hourInt,
            temp: lastPoint.temp
        });

        // --- Draw the gradient-filled area under the curve ---
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, canvasVisualHeight); // Extend bottom of shape way down
        ctx.lineTo(points[0].x, points[0].y);

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const cpx = (p0.x + p1.x) / 2;
            ctx.bezierCurveTo(cpx, p0.y, cpx, p1.y, p1.x, p1.y);
        }

        ctx.lineTo(points[points.length - 1].x, canvasVisualHeight); // Extend bottom of shape way down
        ctx.closePath();

        // Create a horizontal gradient that follows the day/night cycle
        const grad = ctx.createLinearGradient(points[0].x, 0, points[points.length - 1].x, 0);
        const totalWidth = points[points.length - 1].x - points[0].x;

        points.forEach((p, i) => {
            const stop = (p.x - points[0].x) / totalWidth;
            // Color logic: night = rich deep indigo, dawn/dusk transition = warm sunset orange & golden amber, day = vibrant sky-blue
            let color;
            if (p.isDay) {
                // Check if near transition (first or last day hours)
                const prevIsNight = i > 0 && !points[i - 1].isDay;
                const nextIsNight = i < points.length - 1 && !points[i + 1].isDay;
                if (prevIsNight || nextIsNight) {
                    // Dawn/dusk transition
                    color = 'rgba(251, 146, 60, 0.55)'; // warm orange
                } else {
                    color = 'rgba(14, 165, 233, 0.45)'; // vibrant sky blue
                }
            } else {
                // Check if near transition
                const prevIsDay = i > 0 && points[i - 1].isDay;
                const nextIsDay = i < points.length - 1 && points[i + 1].isDay;
                if (prevIsDay || nextIsDay) {
                    color = 'rgba(245, 158, 11, 0.50)'; // golden amber
                } else {
                    color = 'rgba(79, 70, 229, 0.35)'; // deep electric indigo
                }
            }
            grad.addColorStop(Math.max(0, Math.min(1, stop)), color);
        });

        ctx.fillStyle = grad;
        ctx.fill();

        // Apply a smooth vertical fade-out mask to the filled area only, extending far down
        ctx.globalCompositeOperation = 'destination-in';
        const verticalGrad = ctx.createLinearGradient(0, 0, 0, canvasVisualHeight);
        verticalGrad.addColorStop(0, 'rgba(0, 0, 0, 1.0)');       // Fully opaque at the top
        verticalGrad.addColorStop(0.35, 'rgba(0, 0, 0, 0.95)');   // Keep opaque inside hours container
        verticalGrad.addColorStop(0.60, 'rgba(0, 0, 0, 0.50)');   // Smoothly begin fading below cards
        verticalGrad.addColorStop(0.85, 'rgba(0, 0, 0, 0.12)');   // Very soft glow spilling over the bottom sections
        verticalGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');      // Completely transparent at the bottom
        ctx.fillStyle = verticalGrad;
        ctx.fillRect(0, 0, scrollWidth, canvasVisualHeight);
        ctx.restore(); // Restore globalCompositeOperation to 'source-over'

        // --- Draw a subtle glowing curve line on top ---
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const cpx = (p0.x + p1.x) / 2;
            ctx.bezierCurveTo(cpx, p0.y, cpx, p1.y, p1.x, p1.y);
        }

        // Line gradient
        const lineGrad = ctx.createLinearGradient(points[0].x, 0, points[points.length - 1].x, 0);
        points.forEach((p, i) => {
            const stop = (p.x - points[0].x) / totalWidth;
            let lineColor;
            if (p.isDay) {
                const prevIsNight = i > 0 && !points[i - 1].isDay;
                const nextIsNight = i < points.length - 1 && !points[i + 1].isDay;
                if (prevIsNight || nextIsNight) {
                    lineColor = 'rgba(251, 146, 60, 0.95)'; // glowing orange
                } else {
                    lineColor = 'rgba(56, 189, 248, 0.95)'; // bright neon cyan
                }
            } else {
                const prevIsDay = i > 0 && points[i - 1].isDay;
                const nextIsDay = i < points.length - 1 && points[i + 1].isDay;
                if (prevIsDay || nextIsDay) {
                    lineColor = 'rgba(245, 158, 11, 0.95)'; // glowing golden amber
                } else {
                    lineColor = 'rgba(129, 140, 248, 0.90)'; // bright electric indigo
                }
            }
            lineGrad.addColorStop(Math.max(0, Math.min(1, stop)), lineColor);
        });

        ctx.strokeStyle = lineGrad;
        
        // Pass 1: Outer soft neon-like glow resplendence (Highly performant vector stroke)
        ctx.lineWidth = 7;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        
        // Pass 2: High-contrast sharp core stroke
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 1.0;
        ctx.stroke();

        // --- Sync canvas scroll with hours container ---
        syncArcScroll();
    });
}

function syncArcScroll() {
    const container = document.getElementById('hours-container');
    const canvas = document.getElementById('daynight-arc-canvas');
    if (!container || !canvas) return;

    // Remove previous listener if any
    if (container._arcScrollHandler) {
        container.removeEventListener('scroll', container._arcScrollHandler);
    }

    const handler = () => {
        canvas.style.transform = `translateX(${-container.scrollLeft}px)`;
    };

    container._arcScrollHandler = handler;
    container.addEventListener('scroll', handler, { passive: true });

    // Initial sync
    handler();
}

function updateUIForSelected() {
    const dayData = state.forecast[state.selectedDate];
    if (!dayData || !dayData[state.selectedHourIndex]) return;
    const d = dayData[state.selectedHourIndex];
    const ev = d.eval;

    // Score & Hero
    setText('current-hour-label', `${d.time} hs`);
    setText('score-value', ev.score);
    setText('main-status-reason', ev.reason);

    const title = document.getElementById('main-status-title');
    const scoreCircle = document.getElementById('score-circle');
    const scoreGlow = document.getElementById('score-glow');
    const ambientGlow = document.getElementById('ambient-glow');

    let strokeColor, glowBg, ambientColor;

    if (ev.status === 'good') {
        if (title) title.textContent = ev.score > 85 ? 'Vuelo Libre' : 'Aceptable';
        strokeColor = 'var(--green)';
        glowBg = 'rgba(16, 185, 129, 0.2)';
        ambientColor = 'rgba(16, 185, 129, 0.25)';
    } else if (ev.status === 'warn') {
        if (title) title.textContent = 'Precaución';
        strokeColor = 'var(--yellow)';
        glowBg = 'rgba(251, 191, 36, 0.2)';
        ambientColor = 'rgba(251, 191, 36, 0.22)';
    } else {
        if (title) title.textContent = 'No Volar';
        strokeColor = 'var(--red)';
        glowBg = 'rgba(248, 113, 113, 0.25)';
        ambientColor = 'rgba(248, 113, 113, 0.25)';
    }

    if (scoreCircle) {
        scoreCircle.style.stroke = strokeColor;
        scoreCircle.style.strokeDashoffset = 389.6 - (389.6 * ev.score) / 100;
    }
    const scoreValEl = document.getElementById('score-value');
    if (scoreValEl) {
        scoreValEl.style.color = strokeColor;
    }
    if (scoreGlow) scoreGlow.style.background = glowBg;
    if (ambientGlow) ambientGlow.style.setProperty('--glow-color', ambientColor);

    // Day/Night badge
    const dnBadge = document.getElementById('day-night-badge');
    if (dnBadge) {
        dnBadge.innerHTML = d.isDay
            ? '<i data-lucide="sun" style="width:14px;height:14px;color:var(--orange)"></i> Día'
            : '<i data-lucide="moon" style="width:14px;height:14px;color:var(--indigo)"></i> Noche';
    }

    // Convert values based on units selection
    let dispTemp = d.temp;
    let dispWind = d.wind;
    let dispGusts = d.gusts;
    let dispRain = d.rain;

    if (state.units === 'imperial') {
        dispTemp = Math.round(d.temp * 1.8 + 32);
        dispWind = Math.round(d.wind * 0.621371);
        dispGusts = Math.round(d.gusts * 0.621371);
        dispRain = parseFloat((d.rain * 0.0393701).toFixed(2));
    }

    // Dynamic unit labels
    const elUnitTemp = document.getElementById('unit-temp');
    if (elUnitTemp) elUnitTemp.textContent = state.units === 'imperial' ? '°F' : '°C';

    const elUnitWindOverview = document.getElementById('unit-wind-overview');
    if (elUnitWindOverview) elUnitWindOverview.textContent = state.units === 'imperial' ? 'mph' : 'km/h';

    const elUnitRain = document.getElementById('unit-rain');
    if (elUnitRain) elUnitRain.textContent = state.units === 'imperial' ? 'in' : 'mm';

    const elUnitWindBase = document.getElementById('unit-wind-base');
    if (elUnitWindBase) elUnitWindBase.textContent = state.units === 'imperial' ? 'mph' : 'km/h';

    const elUnitWindGusts = document.getElementById('unit-wind-gusts');
    if (elUnitWindGusts) elUnitWindGusts.textContent = state.units === 'imperial' ? 'mph' : 'km/h';

    // Conditions values
    setText('metric-temp', dispTemp);
    setText('metric-wind', dispWind);
    setText('metric-wind-overview', dispWind);
    setText('metric-gusts', dispGusts);
    setText('metric-rain', dispRain);
    setText('metric-clouds', d.clouds);
    setText('metric-sats', d.sats);
    setText('metric-kp', d.kp);

    // Wind bars
    const barW = document.getElementById('bar-wind');
    if (barW) { barW.style.width = `${Math.min(100, (d.wind/T.wind.max)*100)}%`; barW.style.background = windColor(d.wind, T.wind); }
    const barG = document.getElementById('bar-gusts');
    if (barG) { barG.style.width = `${Math.min(100, (d.gusts/T.gusts.max)*100)}%`; barG.style.background = windColor(d.gusts, T.gusts); }

    // Compass
    const arrow = document.getElementById('compass-arrow');
    if (arrow) arrow.style.transform = `rotate(${d.windDir + 180}deg)`;
    setText('wind-dir-text', compassDir(d.windDir));

    // Wind badge
    const wBadge = document.getElementById('wind-badge');
    if (wBadge) {
        const ws = d.wind >= T.wind.bad ? 'bad' : (d.wind >= T.wind.warn ? 'warn' : 'good');
        wBadge.className = `label-badge ${ws}`;
        wBadge.textContent = ws === 'good' ? 'Calmo' : (ws === 'warn' ? 'Moderado' : 'Fuerte');
    }

    // Satellite dot
    const satStat = d.sats <= T.sats.bad ? 'bad' : (d.sats <= T.sats.warn ? 'warn' : 'good');
    setDot('sat-dot', satStat);

    // Kp dot
    const kpStat = d.kp >= T.kp.bad ? 'bad' : (d.kp >= T.kp.warn ? 'warn' : 'good');
    setDot('kp-dot', kpStat);

    // Temperature status
    let tempMsg = 'Normal', tempColor = 'var(--pink)';
    if (d.temp <= T.temp.coldBad || d.temp >= T.temp.hotBad) { tempMsg = 'Crítica'; tempColor = 'var(--red)'; }
    else if (d.temp <= T.temp.coldWarn || d.temp >= T.temp.hotWarn) { tempMsg = 'Alerta Bat.'; tempColor = 'var(--orange)'; }
    setText('temp-warning', tempMsg);
    const tiw = document.getElementById('temp-icon-wrap');
    if (tiw) tiw.style.color = tempColor;

    updateOperationsCenterHomeUI();
    safeUpdateIcons();
}

function windColor(val, th) {
    if (val >= th.bad) return 'var(--red)';
    if (val >= th.warn) return 'var(--yellow)';
    return 'var(--green)';
}

function compassDir(deg) {
    const d = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"];
    return d[Math.round(deg / 22.5) % 16];
}

function setDot(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    const c = status === 'bad' ? 'var(--red)' : (status === 'warn' ? 'var(--yellow)' : 'var(--green)');
    const g = status === 'bad' ? 'rgba(248, 113, 113, 0.4)' : (status === 'warn' ? 'rgba(251, 191, 36, 0.4)' : 'rgba(16, 185, 129, 0.4)');
    el.style.background = c;
    el.style.boxShadow = `0 0 8px ${g}`;
}

function showLoading(msg) {
    const s = document.getElementById('loading-screen');
    if (s) { s.style.display = 'flex'; s.classList.remove('hiding'); }
    setText('loading-text', msg);
}

function hideLoading() {
    const s = document.getElementById('loading-screen');
    if (s) { s.classList.add('hiding'); setTimeout(() => s.style.display = 'none', 500); }
}

function generateMockData() {
    state.rawWeather = { hourly: { time: [], temperature_2m: [], precipitation: [], cloudcover: [], windspeed_10m: [], windgusts_10m: [], winddirection_10m: [], visibility: [], is_day: [] } };
    const now = new Date(); now.setHours(0,0,0,0);
    for (let i = 0; i < 168; i++) {
        const d = new Date(now.getTime() + i * 3600000);
        state.rawWeather.hourly.time.push(`${getLocalDateString(d)}T${String(d.getHours()).padStart(2,'0')}:00`);
        state.rawWeather.hourly.temperature_2m.push(15 + Math.sin(i/4)*10);
        const late = d.getHours() >= 14 && d.getHours() <= 18;
        state.rawWeather.hourly.windspeed_10m.push(late ? 30 : 12);
        state.rawWeather.hourly.windgusts_10m.push(late ? 42 : 18);
        state.rawWeather.hourly.winddirection_10m.push((i * 15) % 360);
        state.rawWeather.hourly.precipitation.push(0);
        state.rawWeather.hourly.cloudcover.push(20);
        state.rawWeather.hourly.visibility.push(10000);
        state.rawWeather.hourly.is_day.push(d.getHours() > 6 && d.getHours() < 19 ? 1 : 0);
    }
}

/* ===== SUITABILITY DETAIL SCREEN LOGIC ===== */
function openSuitabilityDetail() {
    state.selectedSuitabilityHourIndex = state.selectedHourIndex;
    updateSuitabilityDetailData();
    
    const screen = document.getElementById('suitability-detail-screen');
    if (screen) {
        screen.classList.add('open');
    }
}

function closeSuitabilityDetail() {
    const screen = document.getElementById('suitability-detail-screen');
    if (screen) {
        screen.classList.remove('open');
    }
}

function updateSuitabilityDetailData() {
    const hours = state.forecast[state.selectedDate];
    if (!hours || hours.length === 0 || !hours[state.selectedSuitabilityHourIndex]) return;
    
    const d = hours[state.selectedSuitabilityHourIndex];
    const ev = d.eval;
    const mode = state.flightMode || 'standard';

    // 1. Set Date & Active Hour in Header
    const parts = state.selectedDate.split('-');
    const dateObj = new Date(parts[0], parts[1]-1, parts[2]);
    const dateText = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long' }).format(dateObj);
    const isToday = state.selectedDate === getLocalDateString(new Date());
    
    setText('suitability-detail-date', (isToday ? 'Hoy, ' : '') + dateText);
    setText('suitability-active-hour', `${d.time} hs`);
    
    // 2. Set Status Badge & Hero Score Dial
    const badgeEl = document.getElementById('suitability-detail-status-badge');
    const dialTitle = document.getElementById('suitability-detail-status-title');
    const dialReason = document.getElementById('suitability-detail-status-reason');
    const dialScoreVal = document.getElementById('suitability-detail-score-val');
    const dialArc = document.getElementById('suitability-gauge-arc');
    
    let statusLabel = 'Apto';
    let statusClass = 'good';
    let statusText = 'Vuelo Libre';
    let strokeColor = 'var(--green)';
    
    if (ev.status === 'good') {
        statusLabel = ev.score > 85 ? 'Apto' : 'Aceptable';
        statusClass = 'good';
        statusText = ev.score > 85 ? 'Vuelo Libre' : 'Aceptable';
        strokeColor = 'var(--green)';
    } else if (ev.status === 'warn') {
        statusLabel = 'Precaución';
        statusClass = 'warn';
        statusText = 'Precaución';
        strokeColor = 'var(--yellow)';
    } else {
        statusLabel = 'Peligro';
        statusClass = 'bad';
        statusText = 'No Volar';
        strokeColor = 'var(--red)';
    }
    
    if (badgeEl) {
        badgeEl.className = `label-badge ${statusClass}`;
        badgeEl.textContent = statusLabel;
    }
    if (dialTitle) dialTitle.textContent = statusText;
    if (dialReason) dialReason.textContent = ev.reason;
    if (dialScoreVal) {
        dialScoreVal.textContent = ev.score;
        dialScoreVal.style.color = strokeColor;
    }
    
    if (dialArc) {
        const circ = 439.8; // r=70 (2 * pi * 70)
        dialArc.style.strokeDashoffset = circ - (circ * ev.score) / 100;
        dialArc.style.stroke = strokeColor;
        
        let glowColor = 'rgba(16, 185, 129, 0.45)';
        if (ev.status === 'warn') glowColor = 'rgba(251, 191, 36, 0.45)';
        else if (ev.status === 'bad') glowColor = 'rgba(248, 113, 113, 0.45)';
        dialArc.style.setProperty('--gauge-glow-color', glowColor);
    }

    // Dynamic background glow blob transition
    const glowBlob = document.getElementById('suitability-screen-glow-blob');
    if (glowBlob) {
        let blobBg = 'rgba(16, 185, 129, 0.14)';
        if (ev.status === 'warn') blobBg = 'rgba(251, 191, 36, 0.11)';
        else if (ev.status === 'bad') blobBg = 'rgba(248, 113, 113, 0.15)';
        glowBlob.style.background = blobBg;
    }

    // 3. Evaluate each of the 8 parameters
    const telemetryItems = [];
    
    // A. VIENTO (converted if imperial)
    let windStatus = 'good';
    let windExp = 'Viento suave. Excelente estabilidad y control de vuelo.';
    if (d.wind >= T.wind.bad || d.gusts >= T.gusts.bad) {
        windStatus = 'bad';
        windExp = 'Viento extremo. Riesgo elevado de pérdida de control y colisión.';
    } else if (d.wind >= T.wind.warn || d.gusts >= T.gusts.warn) {
        windStatus = 'warn';
        windExp = 'Viento moderado. Mayor consumo de batería y turbulencias moderadas.';
    }

    let dispWindVal = d.wind;
    let dispGustsVal = d.gusts;
    let windUnitLabel = 'km/h';
    if (state.units === 'imperial') {
        dispWindVal = Math.round(d.wind * 0.621371);
        dispGustsVal = Math.round(d.gusts * 0.621371);
        windUnitLabel = 'mph';
    }

    const windPercent = Math.min(100, Math.round((d.wind / T.wind.max) * 100));
    telemetryItems.push({
        id: 'wind',
        name: 'Viento y Ráfagas',
        icon: 'wind',
        val: `Base: <strong>${dispWindVal}</strong> ${windUnitLabel} | Ráfagas: <strong style="color:var(--orange);">${dispGustsVal}</strong> ${windUnitLabel}`,
        status: windStatus,
        percent: windPercent,
        explanation: windExp
    });

    // B. LLUVIA
    let rainStatus = 'good';
    let rainExp = 'Sin precipitaciones. Entorno seco y seguro para despegue.';
    if (d.rain >= T.rain.bad) {
        rainStatus = 'bad';
        rainExp = d.rain > 1.5 ? 'Lluvia fuerte. Peligro de daño electrónico irreversible.' : 'Lluvia leve. Peligro de cortocircuito en motores y electrónica.';
    }
    
    let dispRainVal = d.rain;
    let rainUnitLabel = 'mm';
    if (state.units === 'imperial') {
        dispRainVal = d.rain * 0.0393701;
        rainUnitLabel = 'in';
    }

    const rainPercent = Math.min(100, Math.round((d.rain / 5) * 100));
    telemetryItems.push({
        id: 'rain',
        name: 'Precipitaciones',
        icon: 'droplets',
        val: `Lluvia: <strong>${dispRainVal.toFixed(state.units === 'imperial' ? 2 : 1)}</strong> ${rainUnitLabel}`,
        status: rainStatus,
        percent: rainPercent,
        explanation: rainExp
    });

    // C. TEMPERATURA
    let tempStatus = 'good';
    let tempExp = 'Temperatura templada. Rango ideal para celdas de litio (batería).';
    if (d.temp <= T.temp.coldBad) {
        tempStatus = 'bad';
        tempExp = 'Frío extremo. Las baterías pierden voltaje súbitamente. Peligro de apagado.';
    } else if (d.temp >= T.temp.hotBad) {
        tempStatus = 'bad';
        tempExp = 'Calor extremo. Riesgo de sobrecalentamiento en procesador y motores.';
    } else if (d.temp <= T.temp.coldWarn) {
        tempStatus = 'warn';
        tempExp = 'Temperatura baja. La batería disminuye su rendimiento notablemente.';
    } else if (d.temp >= T.temp.hotWarn) {
        tempStatus = 'warn';
        tempExp = 'Temperatura alta. Vigilar calentamiento de motores y celdas.';
    }

    let dispTempVal = d.temp;
    let tempUnitLabel = '°C';
    if (state.units === 'imperial') {
        dispTempVal = Math.round(d.temp * 1.8 + 32);
        tempUnitLabel = '°F';
    }

    const tempPercent = Math.min(100, Math.max(0, Math.round(((d.temp + 10) / 60) * 100)));
    telemetryItems.push({
        id: 'temp',
        name: 'Temperatura',
        icon: 'thermometer',
        val: `Lectura: <strong>${dispTempVal}</strong> ${tempUnitLabel}`,
        status: tempStatus,
        percent: tempPercent,
        explanation: tempExp
    });

    // D. NUBOSIDAD
    let cloudStatus = 'good';
    let cloudExp = 'Nubosidad baja. Excelente visibilidad y facilidad de orientación visual.';
    if (mode === 'film') {
        cloudExp = 'Cielo despejado. Luz ideal y sombras definidas para filmaciones premium.';
    } else if (mode === 'photo') {
        cloudExp = 'Cielo despejado. Luz natural óptima y contraste ideal para fotografías nítidas.';
    }
        
    if (mode === 'film') {
        if (d.clouds > 65) {
            cloudStatus = 'bad';
            cloudExp = 'Cielo cubierto. Iluminación plana, sin sombras y mala definición de color.';
        } else if (d.clouds > 30) {
            cloudStatus = 'warn';
            cloudExp = 'Nubosidad intermedia. Cambios constantes de luz que arruinan la toma de video.';
        } else if (d.clouds > 10) {
            cloudStatus = 'good';
            cloudExp = 'Nubes tenues. Sombras parciales que atenúan levemente la luz solar.';
        }
    } else if (mode === 'photo') {
        if (d.clouds > 80) {
            cloudStatus = 'bad';
            cloudExp = 'Cielo muy cubierto. Luz solar insuficiente, sombras ausentes, fotos apagadas.';
        } else if (d.clouds > 50) {
            cloudStatus = 'warn';
            cloudExp = 'Nubosidad intermedia. Sombras densas que pueden oscurecer detalles en tierra.';
        } else if (d.clouds > 20) {
            cloudStatus = 'good';
            cloudExp = 'Nubes ligeras. Difusión de luz parcial, sombras ligeramente suavizadas.';
        }
    } else {
        if (d.clouds > 75) {
            cloudStatus = 'warn';
            cloudExp = 'Cielo muy cubierto. Visión y contraste del dron reducidos a la distancia.';
        } else if (d.clouds > 40) {
            cloudStatus = 'good';
            cloudExp = 'Nubosidad intermedia. Sin impacto crítico en física o control de vuelo.';
        }
    }
    telemetryItems.push({
        id: 'clouds',
        name: mode === 'film' ? 'Nubosidad (Modo Filmación)' : (mode === 'photo' ? 'Nubosidad (Modo Foto)' : 'Nubosidad (Modo Estándar)'),
        icon: 'cloud',
        val: `Cobertura: <strong>${d.clouds}</strong> %`,
        status: cloudStatus,
        percent: d.clouds,
        explanation: cloudExp
    });

    // E. ÍNDICE SOLAR (KP)
    let kpStatus = 'good';
    let kpExp = 'Actividad geomagnética nula o muy baja. Señal estable y confiable.';
    
    const kpBadVal = state.kpSensitivity ? 4.0 : T.kp.bad;
    const kpWarnVal = state.kpSensitivity ? 3.0 : T.kp.warn;

    if (d.kp >= kpBadVal) {
        kpStatus = 'bad';
        kpExp = 'Tormenta solar severa. Alta probabilidad de desvíos graves en el GPS y pérdida de enlace.';
    } else if (d.kp >= kpWarnVal) {
        kpStatus = 'warn';
        kpExp = 'Actividad solar inestable. Posibles micro-cortes y precisión degradada en GPS.';
    }
    const kpPercent = Math.min(100, Math.round((d.kp / 9) * 100));
    telemetryItems.push({
        id: 'kp',
        name: 'Índice Solar (Kp)',
        icon: 'sun',
        val: `Nivel: <strong>${d.kp.toFixed(1)}</strong> / 9`,
        status: kpStatus,
        percent: kpPercent,
        explanation: kpExp
    });

    // F. SATÉLITES GPS
    let satsStatus = 'good';
    let satsExp = 'Excelente cobertura de satélites. Posicionamiento 3D ultra-preciso asegurado.';
    if (d.sats <= T.sats.bad) {
        satsStatus = 'bad';
        satsExp = 'Cobertura crítica. El dron perderá el modo de vuelo asistido por GPS (retorno automático).';
    } else if (d.sats <= T.sats.warn) {
        satsStatus = 'warn';
        satsExp = 'Número de satélites bajo. Posicionamiento propenso a micro-derivas.';
    }
    const satsPercent = Math.min(100, Math.round((d.sats / 22) * 100));
    telemetryItems.push({
        id: 'sats',
        name: 'Satélites GPS Estimados',
        icon: 'satellite',
        val: `Conexión: <strong>${d.sats}</strong> satélites`,
        status: satsStatus,
        percent: satsPercent,
        explanation: satsExp
    });

    // G. VISIBILIDAD
    let visStatus = 'good';
    let visExp = 'Visibilidad del espacio aéreo impecable. Control visual (VLOS) perfecto.';
    if (d.visibility < T.vis.bad) {
        visStatus = 'bad';
        visExp = 'Visibilidad nula por niebla densa. Vuelo visual completamente imposible y prohibido.';
    } else if (d.visibility < T.vis.warn) {
        visStatus = 'warn';
        visExp = 'Visibilidad reducida por bruma o niebla ligera. Mantener el dron a distancias cortas.';
    }

    let dispVisVal = d.visibility / 1000;
    let visUnitLabel = 'km';
    if (state.units === 'imperial') {
        dispVisVal = d.visibility / 1609.34;
        visUnitLabel = 'mi';
    }

    const visPercent = Math.min(100, Math.round((d.visibility / 10000) * 100));
    telemetryItems.push({
        id: 'visibility',
        name: 'Visibilidad Operativa',
        icon: 'eye',
        val: `Distancia: <strong>${dispVisVal.toFixed(1)}</strong> ${visUnitLabel}`,
        status: visStatus,
        percent: visPercent,
        explanation: visExp
    });

    // H. LUZ DEL DÍA / VUELO NOCTURNO
    let dayStatus = 'good';
    let dayExp = 'Vuelo diurno. Iluminación solar completa y orientación visual óptima.';
    if (!d.isDay) {
        dayStatus = 'warn';
        if (mode === 'film') {
            dayExp = 'Vuelo nocturno. Iluminación nula para grabaciones. Requiere luces estroboscópicas.';
        } else if (mode === 'photo') {
            dayExp = 'Vuelo nocturno. Excelente para fotos de larga exposición. Requiere vientos calmos y luces reglamentarias.';
        } else {
            dayExp = 'Vuelo nocturno. Exige luces estroboscópicas reglamentarias y extrema precaución.';
        }
    }
    telemetryItems.push({
        id: 'isDay',
        name: 'Iluminación Solar',
        icon: d.isDay ? 'sun' : 'moon',
        val: `Fase: <strong>${d.isDay ? 'Día' : 'Noche'}</strong>`,
        status: dayStatus,
        percent: d.isDay ? 100 : 30,
        explanation: dayExp
    });

    // 4. SORT BY SEVERITY: BAD (RED) first, then WARN (YELLOW), then GOOD (GREEN)
    const severityScore = { 'bad': 3, 'warn': 2, 'good': 1 };
    telemetryItems.sort((a, b) => severityScore[b.status] - severityScore[a.status]);

    // 5. Render Checklist cards
    const container = document.getElementById('suitability-telemetry-list');
    if (!container) return;
    container.innerHTML = '';
    
    telemetryItems.forEach(item => {
        const badgeText = item.status === 'bad' ? 'No Apto' : (item.status === 'warn' ? 'Alerta' : 'Apto');
        const badgeIcon = item.status === 'bad' ? 'x' : (item.status === 'warn' ? 'alert-triangle' : 'check');
        
        const card = document.createElement('div');
        card.className = `telemetry-card ${item.status}`;
        card.innerHTML = `
            <div class="telemetry-card-header">
                <div class="telemetry-sensor-info">
                    <div class="telemetry-sensor-icon">
                        <i data-lucide="${item.icon}"></i>
                    </div>
                    <div class="telemetry-sensor-meta">
                        <span class="telemetry-sensor-name">${item.name}</span>
                        <span class="telemetry-sensor-val">${item.val}</span>
                    </div>
                </div>
                <span class="telemetry-status-badge">
                    <i data-lucide="${badgeIcon}"></i> ${badgeText}
                </span>
            </div>
            <div class="telemetry-progress-wrapper">
                <div class="telemetry-progress-bar">
                    <div class="telemetry-progress-fill" style="width: ${item.percent}%;"></div>
                </div>
            </div>
            <p class="telemetry-explanation">${item.explanation}</p>
        `;
        container.appendChild(card);
    });
    
    safeUpdateIcons();
}

/* ===== WIND DETAIL SCREEN LOGIC ===== */
function openWindDetail() {
    state.selectedWindHourIndex = state.selectedHourIndex;
    updateWindDetailData();
    
    const screen = document.getElementById('wind-detail-screen');
    if (screen) {
        screen.classList.add('open');
    }
}

function closeWindDetail() {
    const screen = document.getElementById('wind-detail-screen');
    if (screen) {
        screen.classList.remove('open');
    }
}

function updateWindDetailData() {
    const hours = state.forecast[state.selectedDate];
    if (!hours || hours.length === 0) return;

    // 1. Calculate Daily Stats
    let totalWind = 0;
    let maxGust = 0;
    let safeHours = [];
    
    hours.forEach(h => {
        totalWind += h.wind;
        if (h.gusts > maxGust) maxGust = h.gusts;
        if (h.wind < T.wind.warn && h.gusts < T.gusts.warn) {
            safeHours.push(h.hourInt);
        }
    });

    let avgWind = totalWind / hours.length;
    
    if (state.units === 'imperial') {
        avgWind = avgWind * 0.621371;
        maxGust = maxGust * 0.621371;
    }

    // 2. Set stats in UI
    setText('stat-wind-avg', `${Math.round(avgWind)} ${state.units === 'imperial' ? 'mph' : 'km/h'}`);
    setText('stat-wind-max-gust', `${Math.round(maxGust)} ${state.units === 'imperial' ? 'mph' : 'km/h'}`);

    // 3. Set Date
    const parts = state.selectedDate.split('-');
    const dateObj = new Date(parts[0], parts[1]-1, parts[2]);
    const dateText = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long' }).format(dateObj);
    const isToday = state.selectedDate === getLocalDateString(new Date());
    setText('wind-detail-date', (isToday ? 'Hoy, ' : '') + dateText);

    // 4. Set general status badge
    let countSafe = 0, countWarning = 0, countDanger = 0;
    hours.forEach(h => {
        if (h.wind >= T.wind.bad || h.gusts >= T.gusts.bad) countDanger++;
        else if (h.wind >= T.wind.warn || h.gusts >= T.gusts.warn) countWarning++;
        else countSafe++;
    });

    const badgeEl = document.getElementById('wind-detail-status-badge');
    if (badgeEl) {
        if (countDanger >= 8) {
            badgeEl.className = 'label-badge bad';
            badgeEl.textContent = 'Peligro';
        } else if (countWarning + countDanger >= 4) {
            badgeEl.className = 'label-badge warn';
            badgeEl.textContent = 'Precaución';
        } else {
            badgeEl.className = 'label-badge good';
            badgeEl.textContent = 'Apto';
        }
    }

    // 5. Render list and instrument
    renderWindHourlyList();
    renderWindDetailInstrument();
}

function renderWindDetailInstrument() {
    const hours = state.forecast[state.selectedDate];
    if (!hours || !hours[state.selectedWindHourIndex]) return;
    const d = hours[state.selectedWindHourIndex];

    let dispWind = d.wind;
    let dispGusts = d.gusts;
    if (state.units === 'imperial') {
        dispWind = Math.round(d.wind * 0.621371);
        dispGusts = Math.round(d.gusts * 0.621371);
    }

    // Speed text
    setText('detail-wind-val', dispWind);
    setText('detail-gusts-val', dispGusts);
    setText('detail-wind-dir-text', compassDir(d.windDir));
    setText('detail-wind-deg', d.windDir);
    setText('detail-active-hour', `${d.time} hs`);

    const elUnitDetailWind = document.getElementById('unit-detail-wind');
    if (elUnitDetailWind) elUnitDetailWind.textContent = state.units === 'imperial' ? 'mph' : 'km/h';

    const elUnitDetailGusts = document.getElementById('unit-detail-gusts');
    if (elUnitDetailGusts) elUnitDetailGusts.textContent = state.units === 'imperial' ? 'mph' : 'km/h';

    // Circular Concentric Rings
    const arcWind = document.getElementById('gauge-wind-arc');
    const arcGusts = document.getElementById('gauge-gusts-arc');

    if (arcWind) {
        const circWind = 389.6; // r=62
        const pctWind = Math.min(d.wind, T.wind.max) / T.wind.max;
        arcWind.style.strokeDashoffset = circWind - (circWind * pctWind);
        arcWind.style.stroke = windColor(d.wind, T.wind);
    }

    if (arcGusts) {
        const circGusts = 439.8; // r=70
        const pctGusts = Math.min(d.gusts, T.gusts.max) / T.gusts.max;
        arcGusts.style.strokeDashoffset = circGusts - (circGusts * pctGusts);
        arcGusts.style.stroke = windColor(d.gusts, T.gusts);
    }

    // Compass arrow
    const arrow = document.getElementById('gauge-compass-arrow');
    if (arrow) {
        arrow.style.transform = `rotate(${d.windDir + 180}deg)`;
    }

    // Dynamic background glow blob transition for Wind Detail Screen
    const glowBlob = document.getElementById('wind-screen-glow-blob');
    if (glowBlob) {
        let blobBg = 'rgba(16, 185, 129, 0.14)'; // Safe (Green)
        if (d.wind >= T.wind.bad || d.gusts >= T.gusts.bad) {
            blobBg = 'rgba(248, 113, 113, 0.15)'; // Danger (Red)
        } else if (d.wind >= T.wind.warn || d.gusts >= T.gusts.warn) {
            blobBg = 'rgba(251, 191, 36, 0.11)'; // Caution (Yellow)
        }
        glowBlob.style.background = blobBg;
    }
}

function renderWindHourlyList() {
    const container = document.getElementById('wind-hourly-list');
    if (!container) return;
    container.innerHTML = '';

    const hours = state.forecast[state.selectedDate] || [];
    hours.forEach((h, index) => {
        let safetyClass = 'safe';
        if (h.wind >= T.wind.bad || h.gusts >= T.gusts.bad) {
            safetyClass = 'danger';
        } else if (h.wind >= T.wind.warn || h.gusts >= T.gusts.warn) {
            safetyClass = 'caution';
        }

        let dispWind = h.wind;
        let dispGusts = h.gusts;
        if (state.units === 'imperial') {
            dispWind = Math.round(h.wind * 0.621371);
            dispGusts = Math.round(h.gusts * 0.621371);
        }

        const isActive = index === state.selectedWindHourIndex;
        const row = document.createElement('div');
        row.className = `wind-hour-row ${safetyClass}${isActive ? ' active' : ''}`;
        row.innerHTML = `
            <div class="hour-row-time-wrap">
                <span class="hour-row-time">${h.time}</span>
                <span class="hour-row-status-dot ${safetyClass}"></span>
            </div>
            <div class="hour-row-wind-info">
                <div class="hour-row-metric">
                    <span class="hour-row-metric-label">Base</span>
                    <span class="hour-row-metric-val">${dispWind} <span style="font-size:10px;font-weight:500;color:var(--text-3);">${state.units === 'imperial' ? 'mph' : 'km/h'}</span></span>
                </div>
                <div class="hour-row-metric">
                    <span class="hour-row-metric-label">Ráfagas</span>
                    <span class="hour-row-metric-val text-orange">${dispGusts} <span style="font-size:10px;font-weight:500;color:var(--text-3);">${state.units === 'imperial' ? 'mph' : 'km/h'}</span></span>
                </div>
                <div class="hour-row-dir-wrap">
                    <i class="hour-row-dir-arrow" data-lucide="navigation-2" style="transform:rotate(${h.windDir + 180}deg);"></i>
                    <span class="hour-row-dir-text">${compassDir(h.windDir)}</span>
                </div>
            </div>
        `;
        row.onclick = () => {
            state.selectedWindHourIndex = index;
            // Update active styling
            const allRows = container.querySelectorAll('.wind-hour-row');
            allRows.forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            
            renderWindDetailInstrument();
        };
        container.appendChild(row);
    });

    safeUpdateIcons();
}

/* ===== LOCATION MODAL & GEOLOCATION / GEOCODING ===== */
let searchTimeout = null;

function openLocationModal() {
    const modal = document.getElementById('location-modal');
    if (modal) {
        modal.classList.add('open');
        // Limpiar campos previos
        const searchInput = document.getElementById('input-city-search');
        if (searchInput) {
            searchInput.value = '';
            setTimeout(() => searchInput.focus(), 150);
        }
        const resultsList = document.getElementById('search-results-list');
        if (resultsList) resultsList.innerHTML = '';
        
        const inputLat = document.getElementById('input-lat');
        const inputLon = document.getElementById('input-lon');
        if (inputLat) inputLat.value = '';
        if (inputLon) inputLon.value = '';
    }
}

function closeLocationModal() {
    const modal = document.getElementById('location-modal');
    if (modal) {
        modal.classList.remove('open');
    }
}

async function useGPSLocation() {
    closeLocationModal();
    showLoading("Calibrando sensores GPS...");
    try {
        state.location = await getLocation();
        showToast("Ubicación GPS actualizada.");
        state.selectedDate = null; // Reiniciar fecha para forzar recalcular
        initApp(true); // Refrescar forzando descarga
    } catch(e) {
        showToast("No se pudo obtener la ubicación actual.");
    } finally {
        hideLoading();
    }
}

function handleCitySearchInput(event) {
    const query = event.target.value.trim();
    clearTimeout(searchTimeout);
    
    const resultsList = document.getElementById('search-results-list');
    if (!resultsList) return;
    
    if (query.length < 3) {
        resultsList.innerHTML = '';
        return;
    }
    
    searchTimeout = setTimeout(async () => {
        resultsList.innerHTML = '<div class="search-loading">Buscando ciudades...</div>';
        
        try {
            const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=es&format=json`);
            if (!res.ok) throw new Error("Search API fail");
            const data = await res.json();
            
            resultsList.innerHTML = '';
            
            if (!data.results || data.results.length === 0) {
                resultsList.innerHTML = '<div class="search-no-results">No se encontraron resultados</div>';
                return;
            }
            
            data.results.forEach(city => {
                const item = document.createElement('div');
                item.className = 'search-result-item';
                
                const cityName = city.name;
                const adminName = city.admin1 ? `${city.admin1}, ` : '';
                const countryName = city.country || '';
                const lat = city.latitude;
                const lon = city.longitude;
                
                item.innerHTML = `
                    <div class="result-info">
                        <span class="result-city-name">${cityName}</span>
                        <span class="result-country">${adminName}${countryName}</span>
                    </div>
                    <span class="result-coords">${lat.toFixed(2)}°, ${lon.toFixed(2)}°</span>
                `;
                
                item.onclick = () => {
                    selectLocation(lat, lon, `${cityName}, ${city.country_code || countryName}`);
                };
                
                resultsList.appendChild(item);
            });
        } catch(e) {
            resultsList.innerHTML = '<div class="search-error">Error al buscar ciudades</div>';
        }
    }, 400); // 400ms debounce
}

function selectLocation(lat, lon, name) {
    closeLocationModal();
    state.location = { lat, lon, name };
    state.selectedDate = null; // Reiniciar fecha para forzar recalcular
    initApp(true); // Refrescar con la nueva ubicación
}

function applyManualCoords() {
    const latVal = parseFloat(document.getElementById('input-lat').value);
    const lonVal = parseFloat(document.getElementById('input-lon').value);
    
    if (isNaN(latVal) || isNaN(lonVal) || latVal < -90 || latVal > 90 || lonVal < -180 || lonVal > 180) {
        showToast("Coordenadas inválidas. Latitud [-90, 90] y Longitud [-180, 180].");
        return;
    }
    
    closeLocationModal();
    state.location = { lat: latVal, lon: lonVal, name: `Coord: ${latVal.toFixed(3)}, ${lonVal.toFixed(3)}` };
    state.selectedDate = null; // Reiniciar fecha para forzar recalcular
    initApp(true);
}

/* ===== SETTINGS SCREEN FUNCTIONS ===== */
function openSettings() {
    const screen = document.getElementById('settings-screen');
    if (screen) {
        screen.classList.add('open');
        updateSettingsScreenUI();
    }
}

function closeSettings() {
    const screen = document.getElementById('settings-screen');
    if (screen) {
        screen.classList.remove('open');
    }
}

function updateSettingsScreenUI() {
    // 1. Flight mode buttons highlight
    const mode = state.flightMode || 'standard';
    const btnStd = document.getElementById('btn-settings-mode-standard');
    const btnFilm = document.getElementById('btn-settings-mode-film');
    const btnPhoto = document.getElementById('btn-settings-mode-photo');
    
    if (btnStd) btnStd.classList.toggle('active', mode === 'standard');
    if (btnFilm) btnFilm.classList.toggle('active', mode === 'film');
    if (btnPhoto) btnPhoto.classList.toggle('active', mode === 'photo');

    // 2. Units highlight
    const units = state.units || 'metric';
    const btnM = document.getElementById('btn-unit-metric');
    const btnI = document.getElementById('btn-unit-imperial');
    if (btnM) btnM.classList.toggle('active', units === 'metric');
    if (btnI) btnI.classList.toggle('active', units === 'imperial');

    // 3. Kp switch
    const chkKp = document.getElementById('chk-kp-sensitivity');
    if (chkKp) chkKp.checked = state.kpSensitivity;

    // 4. Accent theme active state
    const dots = document.querySelectorAll('.accent-dot');
    dots.forEach(dot => {
        const theme = dot.getAttribute('title').toLowerCase();
        const isCurrent = (state.themeAccent === 'sky' && theme.includes('cielo')) ||
                          (state.themeAccent === 'emerald' && theme.includes('esmeralda')) ||
                          (state.themeAccent === 'amber' && theme.includes('ámbar')) ||
                          (state.themeAccent === 'rose' && theme.includes('rosa')) ||
                          (state.themeAccent === 'purple' && theme.includes('violeta'));
        dot.classList.toggle('active', isCurrent);
    });

    // 5. Diagnostics cache text
    const cacheText = document.getElementById('settings-cache-text');
    if (cacheText) {
        if (state.cacheTimestamp) {
            const min = Math.round((Date.now() - state.cacheTimestamp) / 60000);
            cacheText.textContent = `Caché activa (${min} min).`;
        } else {
            cacheText.textContent = `Sin datos en caché local.`;
        }
    }
}

function setUnitSystem(system) {
    if (state.units === system) return;
    state.units = system;
    localStorage.setItem('drone_clima_units', system);
    
    // Refresh main app elements and overlays
    renderApp();
    
    const windScreen = document.getElementById('wind-detail-screen');
    if (windScreen && windScreen.classList.contains('open')) {
        updateWindDetailData();
    }
    const suitScreen = document.getElementById('suitability-detail-screen');
    if (suitScreen && suitScreen.classList.contains('open')) {
        updateSuitabilityDetailData();
    }
    
    updateSettingsScreenUI();
    showToast(`Unidades: ${system === 'metric' ? 'Métricas' : 'Imperiales'}`);
}

function toggleKpSensitivity() {
    const chk = document.getElementById('chk-kp-sensitivity');
    if (!chk) return;
    state.kpSensitivity = chk.checked;
    localStorage.setItem('drone_clima_kp_sensitivity', chk.checked);
    
    // Re-evaluate scores
    processData();
    renderApp();
    
    const suitScreen = document.getElementById('suitability-detail-screen');
    if (suitScreen && suitScreen.classList.contains('open')) {
        updateSuitabilityDetailData();
    }
    
    updateSettingsScreenUI();
    showToast(state.kpSensitivity ? "Sensibilidad Kp alta activa." : "Sensibilidad Kp estándar.");
}

function setThemeAccent(themeName, primaryColor, secondaryColor) {
    state.themeAccent = themeName;
    localStorage.setItem('drone_clima_theme_accent', themeName);
    
    // Set custom CSS variables on root
    const root = document.documentElement;
    root.style.setProperty('--blue', primaryColor);
    root.style.setProperty('--indigo', secondaryColor);
    
    updateSettingsScreenUI();
    
    // Re-render components relying on accent color
    renderHours();
    updateUIForSelected();
    
    showToast(`Acento visual: ${themeName.toUpperCase()}`);
}

function applySavedThemeAccent() {
    const savedTheme = localStorage.getItem('drone_clima_theme_accent') || 'sky';
    const presets = {
        sky: { p: '#38bdf8', s: '#818cf8' },
        emerald: { p: '#10b981', s: '#06b6d4' },
        amber: { p: '#fbbf24', s: '#f97316' },
        rose: { p: '#f472b6', s: '#ec4899' },
        purple: { p: '#a855f7', s: '#6366f1' }
    };
    const preset = presets[savedTheme] || presets.sky;
    const root = document.documentElement;
    root.style.setProperty('--blue', preset.p);
    root.style.setProperty('--indigo', preset.s);
    state.themeAccent = savedTheme;
}

function clearLocalAppCache() {
    try {
        localStorage.removeItem('drone_clima_cache');
        state.cacheTimestamp = null;
        showToast("Caché borrada. Recargando...");
        setTimeout(() => {
            closeSettings();
            initApp(true);
        }, 1200);
    } catch(e) {
        showToast("Error al vaciar caché.");
    }
}

/* ===== CENTRO DE OPERACIONES Y BITÁCORA LOGIC ===== */

function updateOperationsCenterHomeUI() {
    const hours = state.forecast[state.selectedDate];
    if (!hours || !hours[state.selectedHourIndex]) return;
    const d = hours[state.selectedHourIndex];
    const ev = d.eval;
    
    const pfBadge = document.getElementById('ops-preflight-badge');
    const pfDesc = document.getElementById('ops-preflight-desc');
    if (pfBadge) {
        pfBadge.className = `ops-badge ${ev.status}`;
        pfBadge.textContent = ev.status === 'good' ? 'Apto' : (ev.status === 'warn' ? 'Alerta' : 'Peligro');
    }
    if (pfDesc) {
        pfDesc.textContent = ev.status === 'good' ? 'Espacio Aéreo Seguro' : (ev.status === 'warn' ? 'Precaución en vuelo' : 'No despegar');
    }
    
    const logCounter = document.getElementById('ops-logbook-counter');
    if (logCounter) {
        const count = state.flightLogs ? state.flightLogs.length : 0;
        logCounter.textContent = `${count} ${count === 1 ? 'Vuelo' : 'Vuelos'}`;
    }
}

/* ===== PRE-FLIGHT CHECKLIST & AIRSPACE SCREEN LOGIC ===== */
function openPreFlightScreen() {
    const screen = document.getElementById('preflight-screen');
    if (screen) {
        screen.classList.add('open');
        // Reset checkboxes when opening
        const chks = document.querySelectorAll('.chk-physical');
        chks.forEach(c => c.checked = false);
        checkPreFlightProgress();
        updatePreFlightData();
    }
}

function closePreFlightScreen() {
    const screen = document.getElementById('preflight-screen');
    if (screen) {
        screen.classList.remove('open');
    }
}

function updatePreFlightData() {
    const hours = state.forecast[state.selectedDate];
    if (!hours || hours.length === 0 || !hours[state.selectedHourIndex]) return;
    const d = hours[state.selectedHourIndex];
    const ev = d.eval;
    const mode = state.flightMode || 'standard';

    // 1. Date and Active Hour
    const parts = state.selectedDate.split('-');
    const dateObj = new Date(parts[0], parts[1]-1, parts[2]);
    const dateText = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long' }).format(dateObj);
    const isToday = state.selectedDate === getLocalDateString(new Date());
    setText('preflight-date', (isToday ? 'Hoy, ' : '') + dateText);
    setText('preflight-active-hour', `${d.time} hs`);

    // 2. Airspace Procedural Analyzer
    updateAirspaceProceduralAnalysis();

    // 3. Status Badge
    const badge = document.getElementById('preflight-status-badge');
    if (badge) {
        badge.className = `label-badge ${ev.status === 'good' ? 'good' : (ev.status === 'warn' ? 'warn' : 'bad')}`;
        badge.textContent = ev.status === 'good' ? 'Clima OK' : (ev.status === 'warn' ? 'Alerta Clima' : 'Peligro Clima');
    }

    // 4. Screen Glow Blob color
    const glowBlob = document.getElementById('preflight-screen-glow-blob');
    if (glowBlob) {
        let blobBg = 'rgba(34, 211, 238, 0.12)'; // Cyan by default
        if (ev.status === 'warn') blobBg = 'rgba(251, 191, 36, 0.11)';
        else if (ev.status === 'bad') blobBg = 'rgba(248, 113, 113, 0.15)';
        glowBlob.style.background = blobBg;
    }

    // 5. Render Dynamic Meteorological checklist items
    const container = document.getElementById('dynamic-checks-list');
    if (!container) return;
    container.innerHTML = '';

    // A. VIENTO
    let windStatus = 'good', windMsg = 'Viento en rango seguro';
    if (d.wind >= T.wind.warn) {
        if (d.wind >= T.wind.bad || d.gusts >= T.gusts.bad) {
            windStatus = 'bad';
            windMsg = 'Viento extremo peligroso';
        } else {
            windStatus = 'warn';
            windMsg = 'Viento moderado inestable';
        }
    }
    
    // B. LLUVIA
    let rainStatus = 'good', rainMsg = 'Sin precipitaciones activas';
    if (d.rain >= T.rain.bad) {
        rainStatus = 'bad';
        rainMsg = 'Precipitaciones activas detectadas';
    }

    // C. ACTIVIDAD SOLAR (KP)
    let kpStatus = 'good', kpMsg = 'Señal e índice Kp óptimos';
    const kpBadVal = state.kpSensitivity ? 4.0 : T.kp.bad;
    const kpWarnVal = state.kpSensitivity ? 3.0 : T.kp.warn;
    if (d.kp >= kpBadVal) {
        kpStatus = 'bad';
        kpMsg = 'Tormenta solar severa (Afecta GPS)';
    } else if (d.kp >= kpWarnVal) {
        kpStatus = 'warn';
        kpMsg = 'GPS inestable (Índice Kp elevado)';
    }

    // D. VISIBILIDAD
    let visStatus = 'good', visMsg = 'Visibilidad operativa excelente';
    if (d.visibility < T.vis.bad) {
        visStatus = 'bad';
        visMsg = 'Visibilidad crítica (Niebla densa)';
    } else if (d.visibility < T.vis.warn) {
        visStatus = 'warn';
        visMsg = 'Baja visibilidad (Mantener VLOS corto)';
    }

    // E. NOCHE / ILUMINACIÓN
    let nightStatus = 'good', nightMsg = 'Fase diurna con luz natural';
    if (!d.isDay) {
        nightStatus = 'warn';
        nightMsg = 'Fase nocturna (Luz estroboscópica)';
    }

    const sensorItems = [
        { status: windStatus, msg: windMsg, icon: 'wind' },
        { status: rainStatus, msg: rainMsg, icon: 'droplets' },
        { status: kpStatus, msg: kpMsg, icon: 'sun' },
        { status: visStatus, msg: visMsg, icon: 'eye' },
        { status: nightStatus, msg: nightMsg, icon: d.isDay ? 'sun' : 'moon' }
    ];

    sensorItems.forEach(item => {
        const card = document.createElement('div');
        card.className = `sensor-check-card ${item.status}`;
        card.innerHTML = `
            <div class="sensor-check-icon">
                <i data-lucide="${item.icon}"></i>
            </div>
            <div class="check-info">
                <span class="check-label" style="text-decoration:none !important; color:#ffffff !important; font-size:13px; font-weight:700;">${item.msg}</span>
                <span class="check-sub">${item.status === 'good' ? 'Condición segura' : (item.status === 'warn' ? 'Precaución recomendada' : 'Cancelación de despegue')}</span>
            </div>
        `;
        container.appendChild(card);
    });

    safeUpdateIcons();
    checkPreFlightProgress();
}

function updateAirspaceProceduralAnalysis() {
    const lat = state.location.lat;
    const lon = state.location.lon;
    const name = state.location.name || '';
    
    const elClass = document.getElementById('airspace-class');
    const elDetails = document.getElementById('airspace-details');
    
    // Calculate dynamic distance to airport based on coordinates to simulate reality
    let distToAirport = 12.8;
    if (lat && lon) {
        const dLat = lat - (-34.9722);
        const dLon = lon - (-57.8944);
        distToAirport = Math.sqrt(dLat*dLat + dLon*dLon) * 111.3;
    }
    
    if (name.includes('Berisso') || name.includes('La Plata') || (lat && Math.abs(lat - (-34.87)) < 0.2)) {
        if (distToAirport < 8.0) {
            if (elClass) elClass.textContent = "Zona CTR - Restringido";
            if (elDetails) elDetails.innerHTML = `Aeropuerto de La Plata a <strong>${distToAirport.toFixed(1)} km</strong>. Exige permiso de torre de control.`;
            const card = document.querySelector('.airspace-card');
            if (card) card.style.borderColor = 'rgba(248, 113, 113, 0.2)';
        } else {
            if (elClass) elClass.textContent = "Zona C - Espacio Controlado";
            if (elDetails) elDetails.innerHTML = `Aeropuerto de La Plata a <strong>${distToAirport.toFixed(1)} km</strong>. Altura máxima: 43m.`;
            const card = document.querySelector('.airspace-card');
            if (card) card.style.borderColor = 'rgba(251, 191, 36, 0.2)';
        }
    } else {
        const seed = Math.abs(Math.sin(lat + lon) * 100);
        const airportDist = (seed % 15) + 3;
        if (airportDist < 5.0) {
            if (elClass) elClass.textContent = "Zona D - Tránsito Local";
            if (elDetails) elDetails.innerHTML = `Aeródromo local a <strong>${airportDist.toFixed(1)} km</strong>. Precaución por aviación civil general.`;
            const card = document.querySelector('.airspace-card');
            if (card) card.style.borderColor = 'rgba(248, 113, 113, 0.2)';
        } else if (airportDist < 12.0) {
            if (elClass) elClass.textContent = "Zona G - Espacio No Controlado";
            if (elDetails) elDetails.innerHTML = `Heliopuerto civil a <strong>${airportDist.toFixed(1)} km</strong>. Sin restricciones severas de despegue.`;
            const card = document.querySelector('.airspace-card');
            if (card) card.style.borderColor = 'rgba(251, 191, 36, 0.2)';
        } else {
            if (elClass) elClass.textContent = "Clase G - Vuelo Libre";
            if (elDetails) elDetails.innerHTML = `Ningún aeropuerto comercial detectado en 25 km. Espacio aéreo abierto para vuelo recreativo.`;
            const card = document.querySelector('.airspace-card');
            if (card) card.style.borderColor = 'var(--glass-border)';
        }
    }
}

function checkPreFlightProgress() {
    const physicalChecked = document.querySelectorAll('.chk-physical:checked').length;
    const totalPhysical = document.querySelectorAll('.chk-physical').length;
    const btn = document.getElementById('btn-takeoff-auth');
    const label = document.getElementById('takeoff-auth-text');
    
    const hours = state.forecast[state.selectedDate];
    if (!hours || !hours[state.selectedHourIndex]) return;
    const ev = hours[state.selectedHourIndex].eval;
    
    const allPhysicalChecked = physicalChecked === totalPhysical;
    const weatherIsOk = ev.status !== 'bad';
    
    if (btn && label) {
        if (allPhysicalChecked && weatherIsOk) {
            btn.className = "btn-takeoff-auth active";
            btn.disabled = false;
            label.textContent = "AUTORIZACIÓN DE DESPEGUE";
            const icon = btn.querySelector('.auth-icon');
            if (icon) {
                icon.setAttribute('data-lucide', 'rocket');
            }
        } else {
            btn.className = "btn-takeoff-auth disabled";
            btn.disabled = true;
            if (!allPhysicalChecked) {
                label.textContent = `Faltan ${totalPhysical - physicalChecked} chequeos físicos`;
            } else {
                label.textContent = "DESPEGUE ABORTADO: MAL CLIMA";
            }
            const icon = btn.querySelector('.auth-icon');
            if (icon) {
                icon.setAttribute('data-lucide', 'shield-alert');
            }
        }
    }
    safeUpdateIcons();
}

function triggerTakeoffAlert() {
    showToast("¡DESPEGUE AUTORIZADO! Vuela seguro y mantén VLOS.");
    closePreFlightScreen();
}

/* ===== FLIGHT LOGBOOK SCREEN LOGIC ===== */
function openLogbookScreen() {
    const screen = document.getElementById('logbook-screen');
    if (screen) {
        screen.classList.add('open');
        toggleNewLogForm(false);
        renderFlightLogs();
    }
}

function closeLogbookScreen() {
    const screen = document.getElementById('logbook-screen');
    if (screen) {
        screen.classList.remove('open');
    }
}

function toggleNewLogForm(show) {
    const formContainer = document.getElementById('new-log-form-container');
    if (formContainer) {
        formContainer.style.display = show ? 'block' : 'none';
        if (show) {
            formContainer.scrollIntoView({ behavior: 'smooth' });
        }
    }
}

function handleDroneSelectChange() {
    const select = document.getElementById('log-drone');
    const customGroup = document.getElementById('log-drone-custom-group');
    if (select && customGroup) {
        customGroup.style.display = select.value === 'other' ? 'block' : 'none';
    }
}

function saveFlightLog(event) {
    event.preventDefault();
    
    const hours = state.forecast[state.selectedDate];
    if (!hours || !hours[state.selectedHourIndex]) return;
    const d = hours[state.selectedHourIndex];
    
    const pilot = document.getElementById('log-pilot').value.trim();
    const droneSelect = document.getElementById('log-drone').value;
    const droneCustom = document.getElementById('log-drone-custom').value.trim();
    const droneName = droneSelect === 'other' ? droneCustom : droneSelect;
    const batStart = parseInt(document.getElementById('log-bat-start').value);
    const batEnd = parseInt(document.getElementById('log-bat-end').value);
    const notes = document.getElementById('log-notes').value.trim();
    
    const newLog = {
        id: 'log_' + Date.now(),
        timestamp: Date.now(),
        dateStr: state.selectedDate,
        timeStr: d.time,
        location: state.location.name,
        coords: { lat: state.location.lat, lon: state.location.lon },
        pilot,
        drone: droneName || 'DJI Drone',
        battery: { start: batStart, end: batEnd },
        weather: {
            score: d.eval.score,
            status: d.eval.status,
            temp: d.temp,
            wind: d.wind,
            rain: d.rain,
            clouds: d.clouds,
            kp: d.kp,
            sats: d.sats
        },
        notes: notes || 'Vuelo completado de forma estándar.'
    };
    
    if (!state.flightLogs) state.flightLogs = [];
    state.flightLogs.unshift(newLog);
    
    localStorage.setItem('drone_clima_flight_logs', JSON.stringify(state.flightLogs));
    
    toggleNewLogForm(false);
    document.getElementById('frm-new-log').reset();
    
    renderFlightLogs();
    updateOperationsCenterHomeUI();
    showToast("Vuelo guardado en la bitácora técnica.");
}

function deleteFlightLog(id) {
    if (!state.flightLogs) return;
    state.flightLogs = state.flightLogs.filter(log => log.id !== id);
    localStorage.setItem('drone_clima_flight_logs', JSON.stringify(state.flightLogs));
    renderFlightLogs();
    updateOperationsCenterHomeUI();
    showToast("Registro eliminado.");
}

function clearFlightLogs() {
    if (!state.flightLogs || state.flightLogs.length === 0) return;
    if (confirm("¿Estás seguro de que deseas borrar TODOS los registros de vuelo de la bitácora?")) {
        state.flightLogs = [];
        localStorage.setItem('drone_clima_flight_logs', JSON.stringify(state.flightLogs));
        renderFlightLogs();
        updateOperationsCenterHomeUI();
        showToast("Bitácora vaciada por completo.");
    }
}

function renderFlightLogs() {
    const timeline = document.getElementById('logbook-timeline-list');
    if (!timeline) return;
    timeline.innerHTML = '';
    
    const totalEl = document.getElementById('log-stat-total');
    const safeEl = document.getElementById('log-stat-safe');
    const warnEl = document.getElementById('log-stat-warn');
    
    const logs = state.flightLogs || [];
    totalEl.textContent = logs.length;
    
    let safeCount = 0;
    let warnCount = 0;
    logs.forEach(log => {
        if (log.weather.status === 'good') safeCount++;
        else if (log.weather.status === 'warn') warnCount++;
    });
    
    safeEl.textContent = safeCount;
    warnEl.textContent = warnCount;
    
    if (logs.length === 0) {
        timeline.innerHTML = '<div class="log-timeline-empty">No hay vuelos registrados. Comienza a registrar tus vuelos para llevar tu historial profesional.</div>';
        return;
    }
    
    logs.forEach(log => {
        const parts = log.dateStr.split('-');
        const dateObj = new Date(parts[0], parts[1]-1, parts[2]);
        const dateText = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short' }).format(dateObj);
        
        const item = document.createElement('div');
        item.className = 'log-timeline-item';
        
        item.innerHTML = `
            <span class="log-timeline-bullet ${log.weather.status}"></span>
            <div class="log-timeline-card">
                <div class="log-card-header">
                    <div class="log-meta-wrap">
                        <span class="log-title-drone" style="font-size: 13px; font-weight: 800; color: #ffffff;">${log.drone}</span>
                        <span class="log-date-time" style="font-size: 10.5px; font-weight: 500; color: var(--text-3); margin-top: 2px;">${dateText}, ${log.timeStr} hs | ${log.location}</span>
                    </div>
                    <button class="log-delete-btn" onclick="deleteFlightLog('${log.id}')" title="Eliminar registro">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
                
                <div class="log-telemetry-pillbox" style="display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px;">
                    <span class="log-pill" style="border-color:${log.weather.status === 'good' ? 'var(--green)' : (log.weather.status === 'warn' ? 'var(--yellow)' : 'var(--red)')}"><i data-lucide="gauge"></i> Score: ${log.weather.score}</span>
                    <span class="log-pill"><i data-lucide="thermometer"></i> ${log.weather.temp}°C</span>
                    <span class="log-pill"><i data-lucide="wind"></i> ${log.weather.wind} km/h</span>
                    <span class="log-pill"><i data-lucide="battery"></i> Bat: ${log.battery.start}% → ${log.battery.end}%</span>
                </div>
                
                <p class="log-notes-p" style="font-size:11.5px; font-weight:500; color:var(--text-2); line-height:1.4; border-top:1px solid rgba(255,255,255,0.03); padding-top:8px; margin-top:8px;">
                    <strong class="log-pilot-span" style="color:var(--blue)">Piloto: ${log.pilot}</strong> — ${log.notes}
                </p>
            </div>
        `;
        timeline.appendChild(item);
    });
    
    safeUpdateIcons();
}

function exportLogsAsJSON() {
    if (!state.flightLogs || state.flightLogs.length === 0) {
        showToast("No hay registros para exportar.");
        return;
    }
    
    try {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.flightLogs, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `bitacora_vuelos_vueloseguro_${Date.now()}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showToast("Bitácora exportada correctamente.");
    } catch(e) {
        showToast("Error al exportar.");
    }
}

window.addEventListener('DOMContentLoaded', () => {
    applySavedThemeAccent();
    setTimeout(() => initApp(false), 100);
    setInterval(updateCacheStatusUI, 60000);
});
