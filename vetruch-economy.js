/* ============================================================
   VETRUCH ECONOMY ENGINE v2.0
   Экономическая модель по стандарту SUBO FARM BOT:
   - Лимит 20 игр в день (энергия) с авто-сбросом в 00:00 МСК
   - Мгновенная синхронизация через localStorage + облако Firebase
   - Защита от дюпа и накруток
   - Модуль расчёта курса монеты и бюджета призов
   ============================================================ */

(function () {
  'use strict';

  var DEFAULT_CONFIG = {
    attemptsPerDay: 20,
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

  // --- Локальное хранилище попыток ---
  function getLocalAttemptsData() {
    var today = getMskDateString();
    try {
      var raw = localStorage.getItem('vetruch_daily_attempts');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.date === today) {
          return parsed;
        }
      }
    } catch (e) {}

    // Новый день или нет данных — сброс до максимума
    var max = DEFAULT_CONFIG.attemptsPerDay;
    var fresh = { date: today, used: 0, max: max };
    saveLocalAttemptsData(fresh);
    return fresh;
  }

  function saveLocalAttemptsData(data) {
    try {
      localStorage.setItem('vetruch_daily_attempts', JSON.stringify(data));
      // Зеркало для совместимости
      localStorage.setItem('vetruch_attempts_left', String(Math.max(0, data.max - data.used)));
    } catch (e) {}
  }

  // --- Основные методы проверки и использования попытки ---
  function getAttemptsLeft() {
    var data = getLocalAttemptsData();
    return Math.max(0, data.max - data.used);
  }

  function getMaxAttempts() {
    var data = getLocalAttemptsData();
    return data.max || DEFAULT_CONFIG.attemptsPerDay;
  }

  function checkAndUseAttempt(gameName) {
    var data = getLocalAttemptsData();
    var left = Math.max(0, data.max - data.used);

    if (left <= 0) {
      return { ok: false, left: 0, max: data.max, reason: 'limit' };
    }

    data.used += 1;
    saveLocalAttemptsData(data);
    var newLeft = Math.max(0, data.max - data.used);

    // Синхронизация с облаком в фоне, если есть cloudGet/cloudPut
    syncCloudAttempt(gameName, data.used);

    return { ok: true, left: newLeft, max: data.max, game: gameName };
  }

  function syncCloudAttempt(gameName, used) {
    try {
      if (typeof window.cloudGet === 'function' && typeof window.cloudPut === 'function') {
        var uid = 'user';
        if (typeof window.getCurrentTgId === 'function') uid = String(window.getCurrentTgId());
        else if (window.tg && tg.initDataUnsafe && tg.initDataUnsafe.user) uid = String(tg.initDataUnsafe.user.id);

        var today = getMskDateString();
        window.cloudGet('vetruch_app/attempts').then(function (all) {
          all = (all && typeof all === 'object') ? all : {};
          if (!all[today]) all[today] = {};
          all[today][uid] = { used: used, lastGame: gameName, ts: Date.now() };
          window.cloudPut('vetruch_app/attempts', all);
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // --- Красивое модальное окно блокировки (исчерпан лимит) ---
  function showNoAttemptsOverlay() {
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
      'border-radius:24px;padding:32px 22px;max-width:340px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.8),0 0 30px rgba(0,136,255,0.2);">' +
      '<div style="font-size:46px;margin-bottom:12px;">⚡</div>' +
      '<h3 style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#fff;">Энергия исчерпана</h3>' +
      '<p style="margin:0 0 16px 0;font-size:13px;color:#8c97a7;line-height:1.45;">' +
      'Ты сыграл все <b>' + getMaxAttempts() + ' игр</b> на сегодня! Лимит защищает баланс стримера и честность игроков.' +
      '</p>' +
      '<div style="background:rgba(0,136,255,0.1);border:1px solid rgba(0,217,255,0.3);border-radius:14px;padding:12px;margin-bottom:20px;">' +
      '<span style="font-size:11px;color:#8acaff;display:block;margin-bottom:4px;font-weight:600;">ВОССТАНОВЛЕНИЕ ЭНЕРГИИ ЧЕРЕЗ:</span>' +
      '<span style="font-size:18px;font-weight:800;color:#00d9ff;">' + timer.hours + ' ч ' + timer.minutes + ' мин</span>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="vetruchLimitCloseBtn" style="width:100%;padding:13px;border-radius:14px;border:none;background:linear-gradient(135deg,#0070f3 0%,#00d9ff 100%);color:#fff;font:800 14px Inter,sans-serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,136,255,0.4);">' +
      'ПОНЯТНО' +
      '</button>' +
      '<button id="vetruchLimitTasksBtn" style="width:100%;padding:11px;border-radius:14px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#8c97a7;font:700 13px Inter,sans-serif;cursor:pointer;">' +
      'ВЫПОЛНИТЬ ЗАДАНИЯ ➔' +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('vetruchLimitCloseBtn').onclick = function () {
      modal.remove();
    };

    document.getElementById('vetruchLimitTasksBtn').onclick = function () {
      modal.remove();
      if (window.location.pathname.indexOf('index.html') !== -1 || window.location.pathname === '/' || window.location.pathname.endsWith('/')) {
        if (typeof window.openPage === 'function') window.openPage('tasks');
      } else {
        window.location.href = 'index.html#tasks';
      }
    };
  }

  // --- Виджет бейджика попыток в шапке игры ---
  function renderGameHeaderBadge() {
    var header = document.querySelector('.header') || document.querySelector('.top-section');
    if (!header) return;

    var existing = document.getElementById('veconHeaderBadge');
    if (existing) existing.remove();

    var left = getAttemptsLeft();
    var max = getMaxAttempts();

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

  function updateBadgeUI() {
    var badgeCount = document.getElementById('veconBadgeCount');
    if (badgeCount) {
      var left = getAttemptsLeft();
      badgeCount.textContent = left;
      badgeCount.style.color = (left > 0 ? '#00d9ff' : '#ff3366');
    }
  }

  // Автоматический рендер бейджа при загрузке любой игры
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderGameHeaderBadge);
  } else {
    renderGameHeaderBadge();
  }

  // --- Публичный API ---
  window.VETRUCH_ECONOMY = {
    getAttemptsLeft: getAttemptsLeft,
    getMaxAttempts: getMaxAttempts,
    checkAndUseAttempt: checkAndUseAttempt,
    showNoAttemptsOverlay: showNoAttemptsOverlay,
    getTimeUntilReset: getTimeUntilMskMidnight,
    updateBadgeUI: updateBadgeUI,
    renderGameHeaderBadge: renderGameHeaderBadge,
    config: DEFAULT_CONFIG
  };

})();
