/* ============================================================
   VETRUCH ECONOMY ENGINE v3.0
   Экономическая модель по стандарту SUBO FARM BOT:
   - Лимит 20 игр в день НА КАЖДУЮ ИГРУ ОТДЕЛЬНО (Башни, Мины, Карты, Шарик, Кости)
   - Автоматический сброс каждый день в 00:00 по МСК (UTC+3)
   - Встроенный контроль RTP 60% (Return to Player) для всех мини-игр
   - Мгновенная синхронизация через localStorage + облако Firebase
   - Ультра-быстрое открытие игр без задержек
   ============================================================ */

(function () {
  'use strict';

  var GAME_KEYS = ['towers', 'mines', 'cards', 'balloon', 'dice'];
  var GAME_NAMES = {
    towers: 'Башни',
    mines: 'Мины',
    cards: 'Карты',
    balloon: 'Шарик',
    dice: 'Кости'
  };

  var DEFAULT_CONFIG = {
    attemptsPerGame: 20,
    targetRtp: 0.60, // 60% RTP
    budgetRubMonth: 50000,
    ratePer1000: 33, // 1 000 монет ≈ 33 ₽
    dauAssumption: 100,
    circuits: {
      shop: 60,       // Магазин 60%
      giveaways: 20,  // Розыгрыши 20%
      games: 10,      // Игры 10%
      reserve: 10     // Резерв 10%
    }
  };

  // --- Определение текущей игры по имени файла ---
  function detectCurrentGameKey() {
    var path = window.location.pathname.toLowerCase();
    for (var i = 0; i < GAME_KEYS.length; i++) {
      if (path.indexOf(GAME_KEYS[i]) !== -1) {
        return GAME_KEYS[i];
      }
    }
    return null;
  }

  // --- Утилиты времени по МСК (UTC+3) ---
  function getMskDate() {
    var now = new Date();
    return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 3 * 3600000);
  }

  function getMskDateString() {
    var msk = getMskDate();
    var y = msk.getFullYear();
    var m = (msk.getMonth() + 1 < 10 ? '0' : '') + (msk.getMonth() + 1);
    var d = (msk.getDate() < 10 ? '0' : '') + msk.getDate();
    return y + '-' + m + '-' + d;
  }

  function getTimeUntilMskMidnight() {
    var msk = getMskDate();
    var midnight = new Date(msk);
    midnight.setHours(24, 0, 0, 0);
    var diffMs = midnight - msk;
    var hours = Math.floor(diffMs / 3600000);
    var mins = Math.floor((diffMs % 3600000) / 60000);
    return { hours: hours, minutes: mins, totalMs: diffMs };
  }

  // --- Локальное хранилище попыток по каждой игре отдельно ---
  function createFreshAttemptsData(today) {
    var fresh = { date: today, games: {} };
    for (var i = 0; i < GAME_KEYS.length; i++) {
      fresh.games[GAME_KEYS[i]] = { used: 0, max: DEFAULT_CONFIG.attemptsPerGame };
    }
    return fresh;
  }

  function getLocalAttemptsData() {
    var today = getMskDateString();
    try {
      var raw = localStorage.getItem('vetruch_daily_attempts_v3');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.date === today && parsed.games) {
          // Убедимся, что все 5 игр присутствуют
          for (var i = 0; i < GAME_KEYS.length; i++) {
            var k = GAME_KEYS[i];
            if (!parsed.games[k]) {
              parsed.games[k] = { used: 0, max: DEFAULT_CONFIG.attemptsPerGame };
            }
          }
          return parsed;
        }
      }
    } catch (e) {}

    // Новый день или нет данных — создаем свежие 20 попыток для каждой игры
    var fresh = createFreshAttemptsData(today);
    saveLocalAttemptsData(fresh);
    return fresh;
  }

  function saveLocalAttemptsData(data) {
    try {
      localStorage.setItem('vetruch_daily_attempts_v3', JSON.stringify(data));
      // Зеркало для совместимости с прошлыми версиями
      localStorage.setItem('vetruch_daily_attempts', JSON.stringify({
        date: data.date,
        used: 0,
        max: DEFAULT_CONFIG.attemptsPerGame
      }));
    } catch (e) {}
  }

  // --- Основные методы проверки и использования попытки ---
  function normalizeGameKey(gameName) {
    if (gameName && GAME_KEYS.indexOf(gameName.toLowerCase()) !== -1) {
      return gameName.toLowerCase();
    }
    return detectCurrentGameKey() || 'towers';
  }

  function getAttemptsLeft(gameName) {
    var k = normalizeGameKey(gameName);
    var data = getLocalAttemptsData();
    var gameData = data.games[k] || { used: 0, max: DEFAULT_CONFIG.attemptsPerGame };
    return Math.max(0, gameData.max - gameData.used);
  }

  function getMaxAttempts(gameName) {
    var k = normalizeGameKey(gameName);
    var data = getLocalAttemptsData();
    var gameData = data.games[k] || { used: 0, max: DEFAULT_CONFIG.attemptsPerGame };
    return gameData.max || DEFAULT_CONFIG.attemptsPerGame;
  }

  function checkAndUseAttempt(gameName) {
    var k = normalizeGameKey(gameName);
    var data = getLocalAttemptsData();
    if (!data.games[k]) {
      data.games[k] = { used: 0, max: DEFAULT_CONFIG.attemptsPerGame };
    }
    var gameData = data.games[k];
    var left = Math.max(0, gameData.max - gameData.used);

    if (left <= 0) {
      return { ok: false, left: 0, max: gameData.max, game: k, reason: 'limit' };
    }

    gameData.used += 1;
    saveLocalAttemptsData(data);
    var newLeft = Math.max(0, gameData.max - gameData.used);

    // Синхронизация с облаком в фоне
    syncCloudAttempt(k, gameData.used);

    return { ok: true, left: newLeft, max: gameData.max, game: k };
  }

  function resetAllAttempts() {
    var today = getMskDateString();
    var fresh = createFreshAttemptsData(today);
    saveLocalAttemptsData(fresh);
    return fresh;
  }

  function syncCloudAttempt(gameKey, used) {
    try {
      if (typeof window.cloudGet === 'function' && typeof window.cloudPut === 'function') {
        var uid = 'user';
        if (typeof window.getCurrentTgId === 'function') uid = String(window.getCurrentTgId());
        else if (window.tg && tg.initDataUnsafe && tg.initDataUnsafe.user) uid = String(tg.initDataUnsafe.user.id);

        var today = getMskDateString();
        window.cloudGet('vetruch_app/attempts_v3').then(function (all) {
          all = (all && typeof all === 'object') ? all : {};
          if (!all[today]) all[today] = {};
          if (!all[today][uid]) all[today][uid] = {};
          all[today][uid][gameKey] = { used: used, ts: Date.now() };
          window.cloudPut('vetruch_app/attempts_v3', all);
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // --- RTP 60% Модуль (Return to Player) ---
  // Возвращает true, если раунд проходит с победой (шанс 60%).
  // С шансом 40% (house edge) казино забирает перевес.
  function rollRtp(customRtp) {
    var rtp = (typeof customRtp === 'number') ? customRtp : DEFAULT_CONFIG.targetRtp;
    return Math.random() < rtp;
  }

  // --- Красивое модальное окно блокировки (исчерпан лимит для этой игры) ---
  function showNoAttemptsOverlay(gameName) {
    var k = normalizeGameKey(gameName);
    var title = GAME_NAMES[k] || 'Эту игру';

    var old = document.getElementById('vetruch-limit-modal');
    if (old) old.remove();

    var timer = getTimeUntilMskMidnight();

    var modal = document.createElement('div');
    modal.id = 'vetruch-limit-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(5,8,15,0.92);' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,sans-serif;box-sizing:border-box;';

    modal.innerHTML =
      '<div style="background:linear-gradient(180deg,#141c2c 0%,#0c101c 100%);border:1.5px solid rgba(0,136,255,0.4);' +
      'border-radius:24px;padding:30px 20px;max-width:340px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.8),0 0 30px rgba(0,136,255,0.2);">' +
      '<div style="font-size:46px;margin-bottom:12px;">⚡</div>' +
      '<h3 style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#fff;">Лимит игры «' + title + '»</h3>' +
      '<p style="margin:0 0 16px 0;font-size:13px;color:#8c97a7;line-height:1.45;">' +
      'Ты сыграл все <b>' + DEFAULT_CONFIG.attemptsPerGame + ' игр</b> в «' + title + '» на сегодня!<br>' +
      'В каждую из остальных игр у тебя тоже есть по 20 попыток.' +
      '</p>' +
      '<div style="background:rgba(0,136,255,0.1);border:1px solid rgba(0,217,255,0.3);border-radius:14px;padding:12px;margin-bottom:20px;">' +
      '<span style="font-size:11px;color:#8acaff;display:block;margin-bottom:4px;font-weight:600;">ВОССТАНОВЛЕНИЕ В 00:00 МСК:</span>' +
      '<span style="font-size:18px;font-weight:800;color:#00d9ff;">' + timer.hours + ' ч ' + timer.minutes + ' мин</span>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="vetruchLimitOtherGamesBtn" style="width:100%;padding:13px;border-radius:14px;border:none;background:linear-gradient(135deg,#0070f3 0%,#00d9ff 100%);color:#fff;font:800 14px Inter,sans-serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,136,255,0.4);">' +
      'ДРУГИЕ ИГРЫ ➔' +
      '</button>' +
      '<button id="vetruchLimitCloseBtn" style="width:100%;padding:11px;border-radius:14px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#8c97a7;font:700 13px Inter,sans-serif;cursor:pointer;">' +
      'ПОНЯТНО' +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('vetruchLimitCloseBtn').onclick = function () {
      modal.remove();
    };

    document.getElementById('vetruchLimitOtherGamesBtn').onclick = function () {
      modal.remove();
      window.location.href = 'index.html#games';
    };
  }

  // --- Виджет бейджика попыток в шапке игры ---
  function renderGameHeaderBadge(gameName) {
    var k = normalizeGameKey(gameName);
    var header = document.querySelector('.header') || document.querySelector('.top-section');
    if (!header) return;

    var existing = document.getElementById('veconHeaderBadge');
    if (existing) existing.remove();

    var left = getAttemptsLeft(k);
    var max = getMaxAttempts(k);

    var badge = document.createElement('div');
    badge.id = 'veconHeaderBadge';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:rgba(16,24,40,0.85);' +
      'border:1px solid ' + (left > 0 ? 'rgba(0,217,255,0.35)' : 'rgba(255,51,102,0.5)') + ';' +
      'padding:6px 14px;border-radius:20px;font:700 13px Inter,sans-serif;color:#fff;margin-left:auto;margin-right:8px;box-shadow:0 2px 10px rgba(0,0,0,0.3);';

    badge.innerHTML = '⚡ <span id="veconBadgeCount" style="color:' + (left > 0 ? '#00d9ff' : '#ff3366') + '">' + left + '</span> / ' + max;

    // Вставляем перед балансом
    var balPill = header.querySelector('.balance-pill');
    if (balPill && balPill.parentNode === header) {
      header.insertBefore(badge, balPill);
    } else {
      header.appendChild(badge);
    }
  }

  function updateBadgeUI(gameName) {
    var k = normalizeGameKey(gameName);
    var badgeCount = document.getElementById('veconBadgeCount');
    if (badgeCount) {
      var left = getAttemptsLeft(k);
      badgeCount.textContent = left;
      badgeCount.style.color = (left > 0 ? '#00d9ff' : '#ff3366');
    }
  }

  // Автоматический рендер бейджа при загрузке любой игры
  if (detectCurrentGameKey()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { renderGameHeaderBadge(); });
    } else {
      renderGameHeaderBadge();
    }
  }

  // --- Публичный API ---
  window.VETRUCH_ECONOMY = {
    GAME_KEYS: GAME_KEYS,
    GAME_NAMES: GAME_NAMES,
    getAttemptsLeft: getAttemptsLeft,
    getMaxAttempts: getMaxAttempts,
    checkAndUseAttempt: checkAndUseAttempt,
    resetAllAttempts: resetAllAttempts,
    showNoAttemptsOverlay: showNoAttemptsOverlay,
    getTimeUntilReset: getTimeUntilMskMidnight,
    updateBadgeUI: updateBadgeUI,
    renderGameHeaderBadge: renderGameHeaderBadge,
    rollRtp: rollRtp,
    RTP: DEFAULT_CONFIG.targetRtp,
    config: DEFAULT_CONFIG
  };

})();
