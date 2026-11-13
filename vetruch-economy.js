
/* ============================================================
   VETRUCH ECONOMY ENGINE v1.0
   Дневные попытки, расчётные награды, лимиты эмиссии, учёт.
   Строится поверх существующих cloudGet/cloudPut Mini App.
   Расчёт: бюджет 50 000 ₽/мес, курс 1000 мон ≈ 26 ₽,
   DAU 100, 20 попыток/день → эмиссия ≈ 60 600/день (лимит 64 100).
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- КОНФИГ (умолчания, переопределяются из облака) ---------------- */
  var DEFAULTS = {
    attemptsPerDay: 20,
    dailyBonus: 25,
    dayResetHourMSK: 0,
    budgetRubMonth: 50000,
    ratePer1000: 26,
    dauAssumption: 100,
    emissionTargetDay: 64103,
    emissionHardCapDay: 75000,
    emergencyCut: 0.5,
    rewards: {
      dice:    { type: 'evenodd', win: 55, lose: 8 },
      cards:   { type: 'evenodd', win: 55, lose: 8 },
      mines:   { type: 'mines',   base: 3, growth: 1.3 },
      towers:  { type: 'towers',  perFloor: 5 },
      balloon: { type: 'balloon', perPump: 7, maxPumps: 10 }
    }
  };

  /* ---------------- ХРАНИЛИЩЕ ---------------- */
  function lsGet(key) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function lsPut(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  var hasCloud = (typeof window.cloudGet === 'function' && typeof window.cloudPut === 'function');

  function storeGet(key) {
    if (hasCloud) return window.cloudGet(key);
    return Promise.resolve(lsGet('vetruch_ls_' + key));
  }
  function storePut(key, val) {
    if (hasCloud) return window.cloudPut(key, val);
    lsPut('vetruch_ls_' + key, val);
    return Promise.resolve(true);
  }

  /* ---------------- УТИЛИТЫ ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function mskTodayKey() {
    var now = new Date();
    var msk = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 3 * 3600000);
    return msk.getFullYear() + '-' + pad2(msk.getMonth() + 1) + '-' + pad2(msk.getDate());
  }

  function getUserId() {
    if (typeof window.getCurrentTgId === 'function') {
      var id = window.getCurrentTgId();
      if (id) return String(id);
    }
    try {
      var u = window.tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.id) return String(u.id);
    } catch (e) {}
    return 'anon';
  }

  /* ---------------- КОНФИГ ---------------- */
  var configCache = null, configCacheAt = 0;
  function getConfig() {
    if (configCache && Date.now() - configCacheAt < 60000) return Promise.resolve(configCache);
    return Promise.resolve(storeGet('vetruch_app/economy_config')).then(function (saved) {
      var cfg = JSON.parse(JSON.stringify(DEFAULTS));
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (k) {
          if (k === 'rewards' && saved.rewards) {
            Object.keys(saved.rewards).forEach(function (g) { cfg.rewards[g] = saved.rewards[g]; });
          } else if (saved[k] !== undefined) cfg[k] = saved[k];
        });
      }
      cfg.emissionTargetDay = Math.round(cfg.budgetRubMonth / cfg.ratePer1000 * 1000 / 30);
      configCache = cfg; configCacheAt = Date.now();
      return cfg;
    });
  }
  function invalidateConfig() { configCache = null; configCacheAt = 0; }

  /* ---------------- ПОПЫТКИ ---------------- */
  function getAttemptsRaw() {
    return Promise.resolve(storeGet('vetruch_app/attempts')).then(function (d) {
      return (d && typeof d === 'object') ? d : {};
    });
  }

  function getAttemptState(userId) {
    var today = mskTodayKey();
    return getAttemptsRaw().then(function (all) {
      var st = (all[today] && all[today][userId]) ? all[today][userId] : { used: 0, bonus: false, ts: {} };
      return getConfig().then(function (cfg) {
        return { used: st.used || 0, bonus: !!st.bonus, byGame: st.ts || {},
                 left: Math.max(0, cfg.attemptsPerDay - (st.used || 0)), today: today };
      });
    });
  }

  function useAttempt(gameId) {
    var uid = getUserId(), today = mskTodayKey();
    return getConfig().then(function (cfg) {
      return getAttemptsRaw().then(function (all) {
        if (!all[today]) all[today] = {};
        var st = all[today][uid] || { used: 0, bonus: false, ts: {} };
        if ((st.used || 0) >= cfg.attemptsPerDay) {
          return { ok: false, left: 0, reason: 'limit', game: gameId };
        }
        st.used = (st.used || 0) + 1;
        st.ts = st.ts || {}; st.ts[gameId] = (st.ts[gameId] || 0) + 1;
        st.last = Date.now();
        all[today][uid] = st;
        var keys = Object.keys(all).sort();
        while (keys.length > 3) delete all[keys.shift()];
        lsPut('vetruch_attempts_mirror', { date: today, used: st.used, perDay: cfg.attemptsPerDay });
        return storePut('vetruch_app/attempts', all).then(function () {
          return { ok: true, left: cfg.attemptsPerDay - st.used, game: gameId };
        });
      });
    });
  }

  function claimDailyBonus() {
    var uid = getUserId(), today = mskTodayKey();
    return getConfig().then(function (cfg) {
      return getAttemptsRaw().then(function (all) {
        if (!all[today]) all[today] = {};
        var st = all[today][uid] || { used: 0, bonus: false, ts: {} };
        if (st.bonus) return { ok: false, reason: 'already' };
        st.bonus = true;
        all[today][uid] = st;
        return storePut('vetruch_app/attempts', all).then(function () {
          return addBalance(uid, cfg.dailyBonus, 'daily_bonus', { date: today }).then(function () {
            return { ok: true, amount: cfg.dailyBonus };
          });
        });
      });
    });
  }

  /* ---------------- НАГРАДЫ ---------------- */
  function calcReward(gameId, p, cfg) {
    var r = cfg.rewards[gameId];
    if (!r) return 0;
    var amount = 0, k;
    switch (r.type) {
      case 'evenodd':
        amount = p.guessCorrect ? r.win : r.lose;
        break;
      case 'mines':
        var cells = Math.max(0, Math.min(24, p.cellsOpened || 0));
        var cur = r.base;
        for (k = 0; k < cells; k++) { amount += cur; cur *= r.growth; }
        break;
      case 'towers':
        var fl = Math.max(0, Math.min(12, p.floorsClimbed || 0));
        amount = r.perFloor * fl * (fl + 1) / 2;
        break;
      case 'balloon':
        if (p.burst) { amount = 0; break; }
        var pumps = Math.max(0, Math.min(r.maxPumps || 10, p.pumps || 0));
        amount = r.perPump * pumps * (pumps + 1) / 2;
        break;
    }
    return Math.round(amount);
  }

  function checkEmissionCap(amount, cfg) {
    var today = mskTodayKey();
    return Promise.resolve(storeGet('vetruch_app/emission')).then(function (em) {
      em = (em && typeof em === 'object') ? em : {};
      var todayEm = Number(em[today]) || 0;
      if (todayEm + amount > cfg.emissionHardCapDay) {
        amount = Math.round(amount * cfg.emergencyCut);
        if (todayEm + amount > cfg.emissionHardCapDay) amount = 0;
      }
      return { amount: amount, todayEm: todayEm, today: today, em: em };
    });
  }

  function grantReward(gameId, params) {
    params = params || {};
    var uid = getUserId();
    return getConfig().then(function (cfg) {
      var amount = calcReward(gameId, params, cfg);
      if (amount <= 0) return { ok: true, amount: 0, game: gameId };
      return checkEmissionCap(amount, cfg).then(function (chk) {
        if (chk.amount <= 0) return { ok: true, amount: 0, game: gameId, capped: true };
        chk.em[chk.today] = chk.todayEm + chk.amount;
        return storePut('vetruch_app/emission', chk.em).then(function () {
          return addBalance(uid, chk.amount, 'game_' + gameId, params).then(function () {
            return { ok: true, amount: chk.amount, game: gameId, emergency: (chk.amount < amount) };
          });
        });
      });
    });
  }

  /* ---------------- БАЛАНС + ИСТОРИЯ ---------------- */
  function addBalance(uid, amount, type, meta) {
    return Promise.resolve(storeGet('vetruch_app/balances')).then(function (balances) {
      balances = (balances && typeof balances === 'object') ? balances : {};
      balances[uid] = (Number(balances[uid]) || 0) + amount;
      return storePut('vetruch_app/balances', balances).then(function () {
        return Promise.resolve(storeGet('vetruch_app/txlog')).then(function (log) {
          log = Array.isArray(log) ? log : [];
          log.unshift({ t: Date.now(), uid: uid, type: type, amount: amount, meta: meta || {} });
          if (log.length > 500) log = log.slice(0, 500);
          return storePut('vetruch_app/txlog', log);
        });
      }).then(function () {
        if (typeof window.updateBalanceUI === 'function') { try { window.updateBalanceUI(balances[uid]); } catch (e) {} }
        if (typeof window.renderHomePodium === 'function') { try { window.renderHomePodium(); } catch (e) {} }
        return balances[uid];
      });
    });
  }

  /* ---------------- СТАТИСТИКА ДЛЯ АДМИНА ---------------- */
  function getStats() {
    var today = mskTodayKey();
    return Promise.all([getConfig(), storeGet('vetruch_app/emission'),
                        storeGet('vetruch_app/attempts'), storeGet('vetruch_app/balances')]).then(function (r) {
      var cfg = r[0], em = r[1] || {}, att = r[2] || {}, bal = r[3] || {};
      var todayAtt = att[today] || {};
      var playsToday = 0, usersToday = Object.keys(todayAtt).length;
      Object.keys(todayAtt).forEach(function (u) { playsToday += (todayAtt[u].used || 0); });
      var todayEm = Number(em[today]) || 0;
      var totalCoins = Object.keys(bal).reduce(function (a, k) { return a + (Number(bal[k]) || 0); }, 0);
      return {
        date: today,
        config: cfg,
        playersToday: usersToday,
        playsToday: playsToday,
        emissionToday: todayEm,
        emissionTargetDay: cfg.emissionTargetDay,
        emissionHardCapDay: cfg.emissionHardCapDay,
        overTarget: todayEm > cfg.emissionTargetDay,
        emergency: todayEm > cfg.emissionHardCapDay,
        projectedMonthRub: Math.round(todayEm * 30 * cfg.ratePer1000 / 1000),
        budgetRubMonth: cfg.budgetRubMonth,
        totalCoinsInGame: totalCoins,
        coinRatePer1000: cfg.ratePer1000
      };
    });
  }

  function setConfig(patch) {
    return Promise.resolve(storeGet('vetruch_app/economy_config')).then(function (saved) {
      saved = (saved && typeof saved === 'object') ? saved : {};
      Object.keys(patch).forEach(function (k) {
        var parts = k.split('.');
        if (parts.length === 1) { saved[k] = patch[k]; return; }
        saved[parts[0]] = saved[parts[0]] || {};
        saved[parts[0]][parts[1]] = patch[k];
      });
      return storePut('vetruch_app/economy_config', saved).then(function () {
        invalidateConfig();
        return getConfig();
      });
    });
  }

  /* ---------------- UI ---------------- */
  function renderAttemptBadge(mountEl, gameId) {
    if (!mountEl) return;
    function draw(left, perDay) {
      mountEl.innerHTML =
        '<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,.45);' +
        'border:1.5px solid ' + (left > 0 ? 'rgba(0,217,255,.4)' : 'rgba(255,51,102,.6)') + ';' +
        'border-radius:10px;padding:5px 12px;font:800 13px Inter,sans-serif;color:#fff;">' +
        '🎮 Попытки: <span style="color:' + (left > 0 ? '#00d9ff' : '#ff3366') + '">' + left + '/' + perDay + '</span></div>';
    }
    getAttemptState(getUserId()).then(function (st) { draw(st.left, st.used + st.left); });
    var iv = setInterval(function () {
      if (!document.body.contains(mountEl)) { clearInterval(iv); return; }
      getAttemptState(getUserId()).then(function (st) { draw(st.left, st.used + st.left); });
    }, 15000);
  }

  function showNoAttemptsOverlay() {
    var old = document.getElementById('vecon-noattempts');
    if (old) old.remove();
    var now = new Date();
    var msk = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 3 * 3600000);
    var reset = new Date(msk); reset.setHours(24, 0, 0, 0);
    var msLeft = reset - msk;
    var h = Math.floor(msLeft / 3600000), m = Math.floor((msLeft % 3600000) / 60000);

    var ov = document.createElement('div');
    ov.id = 'vecon-noattempts';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
      'font-family:Inter,sans-serif;color:#fff;text-align:center;padding:24px;';
    ov.innerHTML =
      '<div style="font-size:52px;">⏳</div>' +
      '<div style="font-size:22px;font-weight:800;">Дневные попытки закончились</div>' +
      '<div style="font-size:14px;color:#8c97a7;">Загляни в квесты и розыгрыши — там монеты без лимита 😉</div>' +
      '<div style="font-size:16px;font-weight:800;color:#00d9ff;">Новые попытки через ' + h + ' ч ' + m + ' мин</div>' +
      '<button style="margin-top:8px;padding:12px 28px;border-radius:14px;border:none;background:#0088ff;' +
      'color:#fff;font:800 15px Inter,sans-serif;cursor:pointer;">Понял</button>';
    ov.querySelector('button').addEventListener('click', function () { ov.remove(); });
    document.body.appendChild(ov);
  }

  /* ---------------- API ---------------- */
  window.VETRUCH_ECONOMY = {
    getConfig: getConfig,
    setConfig: setConfig,
    getAttemptState: getAttemptState,
    useAttempt: useAttempt,
    claimDailyBonus: claimDailyBonus,
    grantReward: grantReward,
    getStats: getStats,
    renderAttemptBadge: renderAttemptBadge,
    showNoAttemptsOverlay: showNoAttemptsOverlay,
    calcReward: function (gameId, params) {
      return getConfig().then(function (cfg) { return calcReward(gameId, params || {}, cfg); });
    },
    _mskTodayKey: mskTodayKey
  };
})();

