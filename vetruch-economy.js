/* ============================================================
   VETRUCH ECONOMY ENGINE v3.2
   - Лимит 20 игр в день на каждую игру (сброс в 00:00 МСК)
   - Контроль RTP 60%
   - Автоматический учёт суммы всех выигрышей в играх (total_won)
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
    targetRtp: 0.60,
    budgetRubMonth: 50000,
    ratePer1000: 33,
    dauAssumption: 100,
    circuits: {
      shop: 60,
      giveaways: 20,
      games: 10,
      reserve: 10
    }
  };

  function detectCurrentGameKey() {
    var path = window.location.pathname.toLowerCase();
    for (var i = 0; i < GAME_KEYS.length; i++) {
      if (path.indexOf(GAME_KEYS[i]) !== -1) {
        return GAME_KEYS[i];
      }
    }
    return null;
  }

  // --- Учёт всех выигрышей в играх ---
  var currentGameKey = detectCurrentGameKey();
  var origSetItem = Storage.prototype.setItem;
  var roundState = {
    active: false,
    betTaken: false,
    lastBalance: parseInt(localStorage.getItem('vetruch_balance') || '500', 10) || 0
  };

  function getUserIdSafe() {
    try {
      if (window.parent && window.parent !== window && typeof window.parent.getCurrentTgId === 'function') {
        return String(window.parent.getCurrentTgId());
      }
      if (typeof window.getCurrentTgId === 'function') {
        return String(window.getCurrentTgId());
      }
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
        return String(window.Telegram.WebApp.initDataUnsafe.user.id);
      }
    } catch (e) {}
    return '1067693099';
  }

  function recordGameWin(winAmount) {
    if (!winAmount || winAmount <= 0) return;
    var prev = parseInt(localStorage.getItem('vetruch_total_won') || '0', 10) || 0;
    var next = prev + winAmount;
    origSetItem.call(window.localStorage, 'vetruch_total_won', String(next));

    try {
      if (window.parent && window.parent !== window && typeof window.parent.updateTotalWonUI === 'function') {
        window.parent.updateTotalWonUI();
      }
    } catch (e) {}

    try {
      var uid = getUserIdSafe();
      if (window.parent && window.parent !== window && typeof window.parent.cloudPut === 'function') {
        window.parent.cloudPut('vetruch_app/total_won/' + uid, next);
      } else {
        fetch('https://vetruchbot-default-rtdb.firebaseio.com/vetruch_app/total_won/' + encodeURIComponent(uid) + '.json', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next)
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function cancelRound() {
    roundState.active = false;
    roundState.betTaken = false;
    roundState.lastBalance = parseInt(localStorage.getItem('vetruch_balance') || '500', 10) || 0;
  }

  if (currentGameKey) {
    Storage.prototype.setItem = function (key, value) {
      if (this === window.localStorage && key === 'vetruch_balance') {
        var nextBal = parseInt(value, 10);
        if (!isNaN(nextBal)) {
          if (roundState.active && !roundState.betTaken && nextBal < roundState.lastBalance) {
            roundState.betTaken = true;
            roundState.lastBalance = nextBal;
          } else if (roundState.active && roundState.betTaken && nextBal > roundState.lastBalance) {
            var winAmt = nextBal - roundState.lastBalance;
            roundState.active = false;
            roundState.betTaken = false;
            roundState.lastBalance = nextBal;
            recordGameWin(winAmt);
          } else {
            roundState.lastBalance = nextBal;
          }
        }
      }
      return origSetItem.apply(this, arguments);
    };
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

    var fresh = createFreshAttemptsData(today);
    saveLocalAttemptsData(fresh);
    return fresh;
  }

  function saveLocalAttemptsData(data) {
    try {
      localStorage.setItem('vetruch_daily_attempts_v3', JSON.stringify(data));
      localStorage.setItem('vetruch_daily_attempts', JSON.stringify({
        date: data.date,
        used: 0,
        max: DEFAULT_CONFIG.attemptsPerGame
      }));
    } catch (e) {}
  }

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

    if (currentGameKey) {
      roundState.active = true;
      roundState.betTaken = false;
      roundState.lastBalance = parseInt(localStorage.getItem('vetruch_balance') || '500', 10) || 0;
    }

    gameData.used += 1;
    saveLocalAttemptsData(data);
    var newLeft = Math.max(0, gameData.max - gameData.used);

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
        var uid = getUserIdSafe();
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

  function rollRtp(customRtp) {
    var rtp = (typeof customRtp === 'number') ? customRtp : DEFAULT_CONFIG.targetRtp;
    return Math.random() < rtp;
  }

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
      '<h3 style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#fff;">Лимит на сегодня</h3>' +
      '<p style="margin:0 0 16px 0;font-size:13px;color:#8c97a7;line-height:1.45;">' +
      'Ты сыграл все <b>' + DEFAULT_CONFIG.attemptsPerGame + ' игр</b> в «' + title + '» на сегодня!<br>' +
      'Лимит 20 игр действует на каждую игру отдельно.' +
      '</p>' +
      '<div style="background:rgba(0,136,255,0.1);border:1px solid rgba(0,217,255,0.3);border-radius:14px;padding:12px;margin-bottom:20px;">' +
      '<span style="font-size:11px;color:#8acaff;display:block;margin-bottom:4px;font-weight:600;">ВОССТАНОВЛЕНИЕ В 00:00 МСК:</span>' +
      '<span style="font-size:18px;font-weight:800;color:#00d9ff;">' + timer.hours + ' ч ' + timer.minutes + ' мин</span>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="vetruchLimitCloseBtn" style="width:100%;padding:13px;border-radius:14px;border:none;background:linear-gradient(135deg,#0070f3 0%,#00d9ff 100%);color:#fff;font:800 14px Inter,sans-serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,136,255,0.4);">' +
      'ПОНЯТНО' +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('vetruchLimitCloseBtn').onclick = function () {
      modal.remove();
      if (typeof window.goBack === 'function') {
        window.goBack();
      }
    };
  }

  function renderGameHeaderBadge() {
    var existing = document.getElementById('veconHeaderBadge');
    if (existing) existing.remove();
  }

  function updateBadgeUI() {
    var existing = document.getElementById('veconHeaderBadge');
    if (existing) existing.remove();
  }

  document.addEventListener('DOMContentLoaded', function() {
    renderGameHeaderBadge();
  });

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
    cancelRound: cancelRound,
    recordGameWin: recordGameWin,
    rollRtp: rollRtp,
    RTP: DEFAULT_CONFIG.targetRtp,
    config: DEFAULT_CONFIG
  };

})();
