/* =========================================================================
 * 知识点网站 · 应用逻辑
 *  - 分库（每个学习者独立知识点 + 独立进度）
 *  - 章节树（科目→章节→知识点，可折叠）
 *  - 全文搜索（知识点/题目/答案）
 *  - 问答卡（答案默认隐藏，点开显示）
 *  - 间隔复习（累计答对 5 次=掌握；答错当天重练；三视图：今日复习/自由学习/错题重练）
 *  - 音频：Web Audio 解锁播放 + 本地解码 + <audio> 回退；听写模式
 *  - 进度：localStorage 本地保存（无云依赖）+ 导出/导入 JSON（换机迁移）
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------------- 状态 ---------------- */
  var LIBS = window.KP_LIBS || {};
  var libOrder = Object.keys(LIBS);
  // 默认库依据访问域名自动选择：含 'yyx' 的域名（yyx.github.io）默认杨研行；其余默认杨知行。
  // 这样同一份代码部署到两个 GitHub 用户页仓库时零差异，无需改配置。
  var _defaultLib = (location.hostname.indexOf('yyx') >= 0 && libOrder.indexOf('yanxing') >= 0) ? 'yanxing' : libOrder[0];
  var currentLib = _defaultLib;
  var view = 'review';        // review | study | wrong | detail
  var detailNo = null;
  var backTarget = 'review';
  var qOpenTime = 0;
  var searchKw = '';
  var openState = {};         // 树折叠状态：'subj:语文' / 'chap:语文/古诗默写'

  function lib() { return LIBS[currentLib]; }
  function items() { return lib().items || []; }
  function itemByNo(no) { return items().filter(function (it) { return it.no === no; })[0]; }

  /* ---------------- 进度存储（分库 / localStorage / 无云） ---------------- */
  function evKey() { return 'kplib_events_' + currentLib; }
  function revKey() { return 'kplib_rev_' + currentLib; }
  var events = [];
  function loadEvents() { try { events = JSON.parse(localStorage.getItem(evKey()) || '[]') || []; } catch (e) { events = []; } }
  function saveEvents() { try { localStorage.setItem(evKey(), JSON.stringify(events)); } catch (e) {} }
  function loadRev() { try { return JSON.parse(localStorage.getItem(revKey()) || '{}') || {}; } catch (e) { return {}; } }
  function saveRev(m) { try { localStorage.setItem(revKey(), JSON.stringify(m)); } catch (e) {} }

  /* ---------------- 分数 / 复习（复用原站机制） ---------------- */
  var scores = {};
  function computeScores() { scores = {}; for (var i = 0; i < events.length; i++) { var e = events[i]; scores[e.no] = (scores[e.no] || 0) + e.d; } }
  function getScore(no) { return scores[no] || 0; }

  var MASTER_CORRECT = 5;             // 累计答对达此数即“已掌握”
  var STAGES = [0, 1, 2, 4, 7, 15];   // stage0..5 -> 下次复习间隔(天)，艾宾浩斯式拉长
  var REVIEW_DAILY = 5;
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function yestStr() { var d = new Date(Date.now() - 86400000); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function isFresh(it) { return (it.date || '') === todayStr(); }
  function reviewable(it) { return !it.qimg; }   // 作文图对照不参与复习

  function deriveStatus(no) {
    var evs = events.filter(function (e) { return e.no === no; });
    var correct = evs.filter(function (e) { return e.d > 0; }).length;
    var wrong = evs.filter(function (e) { return e.d < 0; }).length;
    var lastT = 0, lastOK = true;
    if (evs.length) { var s = evs.slice().sort(function (a, b) { return b.t - a.t; })[0]; lastT = s.t; lastOK = s.d > 0; }
    var stage = Math.min(correct, 5);
    var interval = STAGES[stage] * 86400000;
    var due = lastT ? lastT + interval : 0;   // 从未学过 → due=0，视为立即到期（避免 Date.now() 竞态把新条目全部排除）
    return { correct: correct, wrong: wrong, lastT: lastT, lastOK: lastOK, stage: stage, interval: interval, due: due };
  }
  function buildTodayList() {
    var now = Date.now();
    var retry = items().filter(function (it) { return reviewable(it); }).filter(function (it) { var s = deriveStatus(it.no); return s.correct > 0 && !s.lastOK; });
    var fresh = items().filter(function (it) { return reviewable(it) && isFresh(it); });
    var freshNos = fresh.map(function (it) { return it.no; });
    var pool = items().filter(function (it) { return reviewable(it) && freshNos.indexOf(it.no) === -1; })
      .filter(function (it) { var s = deriveStatus(it.no); return s.due <= now && !(s.correct > 0 && !s.lastOK); });
    pool.sort(function (a, b) { var sa = deriveStatus(a.no), sb = deriveStatus(b.no); if (sa.stage !== sb.stage) return sa.stage - sb.stage; return sa.due - sb.due; });
    var list = [];
    retry.forEach(function (it) { if (list.length < REVIEW_DAILY) list.push(it.no); });
    fresh.forEach(function (it) { if (list.length < REVIEW_DAILY && list.indexOf(it.no) === -1) list.push(it.no); });
    for (var i = 0; i < pool.length; i++) { if (list.length >= REVIEW_DAILY) break; if (list.indexOf(pool[i].no) === -1) list.push(pool[i].no); }
    if (list.length < REVIEW_DAILY) {
      var extra = items().filter(function (it) { return reviewable(it) && list.indexOf(it.no) === -1; }).filter(function (it) { return deriveStatus(it.no).correct >= MASTER_CORRECT; });
      for (var j = 0; j < extra.length; j++) { if (list.length >= REVIEW_DAILY) break; if (list.indexOf(extra[j].no) === -1) list.push(extra[j].no); }
    }
    var wrong = items().filter(function (it) { return reviewable(it) && list.indexOf(it.no) === -1; })
      .filter(function (it) { var s = deriveStatus(it.no); return s.correct > 0 && !s.lastOK; }).map(function (it) { return it.no; });
    return { list: list, wrong: wrong };
  }
  function todayDoneNo(no) { var t0 = new Date(); t0.setHours(0, 0, 0, 0); return events.some(function (e) { return e.no === no && e.t >= t0.getTime(); }); }
  function reviewDoneCount(list) { return list.filter(todayDoneNo).length; }
  function reviewAllDone(list) { return list.length > 0 && reviewDoneCount(list) >= list.length; }
  function getStars() { return events.filter(function (e) { return e.d > 0; }).length; }
  function checkIn() {
    var list = buildTodayList().list;
    if (!reviewAllDone(list)) return;
    var m = loadRev(); var t = todayStr();
    if (m.last === t) return;
    m.streak = (m.last === yestStr()) ? (m.streak || 0) + 1 : 1;
    m.last = t; saveRev(m);
  }
  function revMeta() { var m = loadRev(); return { streak: m.streak || 0 }; }

  /* ---------------- 音频（复用原站 Web Audio 解锁 + 本地解码 + 回退） ---------------- */
  var _actx = null, _bufCache = {}, currentSrc = null, currentAudio = null;
  function getCtx() {
    if (!_actx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { _actx = new AC(); } catch (e) { _actx = null; } } }
    return _actx;
  }
  function stopPlayback() {
    if (currentSrc) { try { currentSrc.onended = null; currentSrc.stop(0); } catch (e) {} currentSrc = null; }
    if (currentAudio) { try { currentAudio.onended = null; currentAudio.pause(); } catch (e) {} currentAudio = null; }
  }
  function playAudio(url, onDone) {
    var finished = false;
    function done() { if (!finished) { finished = true; if (onDone) onDone(); } }
    var ctx = getCtx();
    if (!ctx) { playFallback(url, done); return; }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    function bufThen(buf) {
      try { var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.onended = done; src.start(0); currentSrc = src; }
      catch (e) { done(); }
    }
    if (_bufCache[url]) { bufThen(_bufCache[url]); return; }
    fetch(url).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); })
      .then(function (buf) { _bufCache[url] = buf; bufThen(buf); })
      .catch(function () { playFallback(url, done); });
  }
  function playFallback(url, done) {
    try { var a = new Audio(url); a.preload = 'auto'; a.onended = done; a.onerror = done; currentAudio = a; a.play().catch(done); }
    catch (e) { done(); }
  }
  /* 听写模式：按 no-N.mp3 顺序念词，逐词停顿，结束自动显答案 */
  function dictGap(word) { var n = (word || '').split(/\s+/).filter(Boolean).length; if (n >= 4) return 10000; if (n === 3) return 7000; return 5000; }
  var dictState = { on: false, timer: null, queue: [], total: 0, no: '' };
  function splitWords(p) { return (p || '').split('　').map(function (s) { return s.trim(); }).filter(Boolean); }
  function startDictation(words, no) {
    if (!words || !words.length) return;
    if (dictState.on) { stopDictation(); return; }
    dictState.no = no || ''; dictState.on = true; dictState.queue = words.slice(); dictState.total = words.length;
    var btn = document.getElementById('dict'); if (btn) { btn.textContent = '⏹ 停止听写'; btn.classList.add('stop'); }
    var st = document.getElementById('dictstatus'); if (st) st.textContent = '准备听写…';
    playAudio('assets/audio/prep.mp3', function () { if (dictState.on) dictState.timer = setTimeout(speakDictNext, 700); });
  }
  function speakDictNext() {
    if (!dictState.on) return;
    var st = document.getElementById('dictstatus');
    if (dictState.queue.length) {
      var w = dictState.queue.shift();
      var done = dictState.total - dictState.queue.length;
      if (st) st.textContent = '正在念第 ' + done + ' / ' + dictState.total + ' 个，听完写在本子上…';
      var localUrl = 'assets/audio/' + encodeURIComponent(dictState.no) + '-' + done + '.mp3';
      var gap = dictGap(w);
      playAudio(localUrl, function () { if (dictState.on) dictState.timer = setTimeout(speakDictNext, gap); });
    } else {
      stopDictation();
      var ans = document.getElementById('ans'), row = document.getElementById('row'), tg = document.getElementById('toggle');
      if (ans) ans.classList.add('show'); if (row) row.classList.add('show');
      if (tg) { tg.textContent = '收起答案'; tg.classList.add('open'); }
      var st2 = document.getElementById('dictstatus'); if (st2) st2.textContent = '✔ 听写完成，对照答案检查';
      playAudio('assets/audio/done.mp3', null);
    }
  }
  function stopDictation() {
    dictState.on = false;
    if (dictState.timer) { clearTimeout(dictState.timer); dictState.timer = null; }
    stopPlayback();
    var btn = document.getElementById('dict'); if (btn) { btn.textContent = '▶ 开始听写'; btn.classList.remove('stop'); }
    var st = document.getElementById('dictstatus'); if (st) st.textContent = '';
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function numCls(n) { return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }
  function $(id) { return document.getElementById(id); }

  /* ---------------- DOM 引用 ---------------- */
  var mainEl = $('main');
  var libNameEl = $('libName');

  /* ---------------- 渲染：今日复习 ---------------- */
  function renderReview() {
    var lr = buildTodayList(); var list = lr.list;
    var done = reviewDoneCount(list); var all = reviewAllDone(list);
    checkIn();
    var meta = revMeta();
    var pct = list.length ? Math.round(done / list.length * 100) : 0;
    var html = '';
    html += '<div class="rstrip">'
      + '<div class="cell"><div class="v">' + done + '/' + list.length + '</div><div class="l">今日复习</div></div>'
      + '<div class="cell"><div class="v">' + meta.streak + '</div><div class="l">连续打卡(天)</div></div>'
      + '<div class="cell"><div class="v">' + getStars() + '</div><div class="l">⭐ 星星</div></div>'
      + '</div>';
    html += '<div class="rprog"><div class="pt"><span>今日进度</span><span>' + done + '/' + list.length + '</span></div><div class="rbar"><i style="width:' + pct + '%"></i></div></div>';
    if (all) {
      html += '<div class="rwell"><div class="big">🎉 今日复习完成！</div>今天 ' + list.length + ' 条都过了，明天再来巩固~</div>';
    } else {
      html += '<div class="rstitle">📋 今日待复习（剩 ' + (list.length - done) + '）</div>';
      html += list.map(function (no) {
        var it = itemByNo(no); if (!it) return '';
        var sd = deriveStatus(no);
        var st = todayDoneNo(no) ? 'done' : (sd.lastOK ? 'pend' : 'err');
        var mark = todayDoneNo(no) ? '✓' : (sd.lastOK ? '待' : '错');
        var preview = it.pinyin ? '🎧 听写练习' : it.q.replace(/\n/g, ' ').slice(0, 22);
        return '<div class="ritem" data-no="' + esc(no) + '"><div class="st ' + st + '">' + mark + '</div><div class="rb"><div class="rkp">' + esc(it.kp) + '</div><div class="rpv">' + esc(preview) + '</div></div><div class="arrow">›</div></div>';
      }).join('');
    }
    if (lr.wrong.length) {
      html += '<div class="rstitle">❌ 待重练错题（' + lr.wrong.length + '）</div>';
      html += lr.wrong.map(function (no) { var it = itemByNo(no); return '<div class="ritem" data-no="' + esc(no) + '"><div class="st err">错</div><div class="rb"><div class="rkp">' + esc(it.kp) + '</div><div class="rpv">答错过，需重练直到答对</div></div><div class="arrow">›</div></div>'; }).join('');
    }
    mainEl.innerHTML = html;
    mainEl.querySelectorAll('.ritem').forEach(function (el) {
      el.addEventListener('click', function () { backTarget = 'review'; detailNo = el.dataset.no; view = 'detail'; render(); });
    });
  }

  /* ---------------- 渲染：错题重练 ---------------- */
  function renderWrong() {
    var wrong = items().filter(function (it) { return reviewable(it); }).filter(function (it) { var s = deriveStatus(it.no); return s.correct > 0 && !s.lastOK; });
    var html = '<div class="rstrip"><div class="cell"><div class="v">' + wrong.length + '</div><div class="l">待重练错题</div></div></div>';
    if (wrong.length) {
      html += wrong.map(function (it) { return '<div class="ritem" data-no="' + esc(it.no) + '"><div class="st err">错</div><div class="rb"><div class="rkp">' + esc(it.kp) + '</div><div class="rpv">答错需重练，答对自动移出</div></div><div class="arrow">›</div></div>'; }).join('');
    } else {
      html += '<div class="rwell"><div class="big">👍 没有待重练错题</div>继续保持~</div>';
    }
    mainEl.innerHTML = html;
    mainEl.querySelectorAll('.ritem').forEach(function (el) {
      el.addEventListener('click', function () { backTarget = 'wrong'; detailNo = el.dataset.no; view = 'detail'; render(); });
    });
  }

  /* ---------------- 渲染：自由学习（章节树 + 搜索） ---------------- */
  function buildTree() {
    var tree = {};
    items().forEach(function (it) {
      var s = it.subject || '未分类', c = it.chapter || '其他';
      if (!tree[s]) tree[s] = {};
      if (!tree[s][c]) tree[s][c] = [];
      tree[s][c].push(it);
    });
    return tree;
  }
  function renderStudy() {
    var html = '';
    html += '<div class="searchbar"><input id="searchInput" type="search" placeholder="搜索知识点 / 题目 / 答案…" value="' + esc(searchKw) + '"><button class="clear" id="searchClear">清除</button></div>';
    html += '<div id="studyContent"></div>';
    html += '<div class="tools"><button class="tbtn" id="btnExport">⬇ 导出进度</button><button class="tbtn" id="btnImport">⬆ 导入进度</button></div>';
    html += '<div class="empty" style="padding:14px 0 0;font-size:12px;line-height:1.8;">进度仅存在本机浏览器。换手机前点「导出进度」存一份；新手机点「导入进度」恢复，零外部依赖。</div>';
    mainEl.innerHTML = html;
    var si = $('searchInput');
    if (si) { si.addEventListener('input', function () { searchKw = si.value; renderStudyContent(); }); si.focus(); }
    var sc = $('searchClear'); if (sc) sc.addEventListener('click', function () { searchKw = ''; renderStudy(); });
    var be = $('btnExport'); if (be) be.addEventListener('click', exportProgress);
    var bi = $('btnImport'); if (bi) bi.addEventListener('click', openImport);
    renderStudyContent();
  }
  function renderStudyContent() {
    var box = $('studyContent');
    if (!box) return;
    if (searchKw.trim()) {
      var kw = searchKw.trim().toLowerCase();
      var hits = items().filter(function (it) {
        return (it.kp || '').toLowerCase().indexOf(kw) >= 0
          || (it.q || '').toLowerCase().indexOf(kw) >= 0
          || (it.a || '').toLowerCase().indexOf(kw) >= 0
          || (it.no || '').toLowerCase().indexOf(kw) >= 0;
      });
      var h = '<div class="rstitle">🔍 找到 ' + hits.length + ' 条</div>';
      if (hits.length) {
        h += '<div class="tree">' + hits.map(function (it) {
          var preview = it.pinyin ? '🎧 听写练习' : it.q.replace(/\n/g, ' ').slice(0, 26);
          return '<div class="leaf-item" data-no="' + esc(it.no) + '"><div class="leaf-score ' + numCls(getScore(it.no)) + '">' + getScore(it.no) + '<span class="u">分</span></div><div class="leaf-body"><div class="leaf-kp">' + esc(it.kp) + '</div><div class="leaf-preview' + (it.pinyin ? ' dict' : '') + '">' + esc(preview) + '</div></div><div class="arrow">›</div></div>';
        }).join('') + '</div>';
      } else {
        h += '<div class="empty">没有匹配的知识点。<br>换个关键词试试。</div>';
      }
      box.innerHTML = h;
    } else {
      var tree = buildTree();
      var subs = Object.keys(tree);
      if (subs.length === 0) {
        box.innerHTML = '<div class="empty">【' + esc(lib().name) + '】库暂无内容，敬请期待。<br>可点击右上角「☰ 库」切换到【杨知行】库查看现有 ' + (LIBS['zhixing'] ? (LIBS['zhixing'].items || []).length : 0) + ' 条知识点。</div>';
        return;
      }
      var h2 = '<div class="tree" id="tree">';
      subs.forEach(function (s) {
        var subOpen = openState['subj:' + s] !== false;
        h2 += '<div class="tree-row subj' + (subOpen ? ' open' : '') + '" data-key="subj:' + esc(s) + '"><span class="tw">▶</span><span class="label">' + esc(s) + '</span><span class="count">' + Object.keys(tree[s]).length + ' 章</span></div>';
        h2 += '<div class="tree-sub' + (subOpen ? ' open' : '') + '" data-sub="subj:' + esc(s) + '">';
        Object.keys(tree[s]).forEach(function (c) {
          var chapOpen = openState['chap:' + s + '/' + c] !== false;
          h2 += '<div class="tree-row chap' + (chapOpen ? ' open' : '') + '" data-key="chap:' + esc(s + '/' + c) + '"><span class="tw">▶</span><span class="label">' + esc(c) + '</span><span class="count">' + tree[s][c].length + '</span></div>';
          h2 += '<div class="tree-leaf' + (chapOpen ? ' open' : '') + '" data-leaf="chap:' + esc(s + '/' + c) + '">';
          tree[s][c].forEach(function (it) {
            var n = getScore(it.no);
            var preview = it.pinyin ? '🎧 听写练习' : it.q.replace(/\n/g, ' ').slice(0, 30);
            h2 += '<div class="leaf-item" data-no="' + esc(it.no) + '"><div class="leaf-score ' + numCls(n) + '">' + n + '<span class="u">分</span></div><div class="leaf-body"><div class="leaf-kp">' + esc(it.kp) + '</div><div class="leaf-preview' + (it.pinyin ? ' dict' : '') + '">' + esc(preview) + '</div></div><div class="arrow">›</div></div>';
          });
          h2 += '</div>';
        });
        h2 += '</div>';
      });
      h2 += '</div>';
      box.innerHTML = h2;

      // 树折叠
      box.querySelectorAll('.tree-row.subj, .tree-row.chap').forEach(function (row) {
        row.addEventListener('click', function () {
          var key = row.dataset.key;
          var isOpen = openState[key] === false ? true : false;   // 默认 undefined→false(收起)
          openState[key] = isOpen;
          row.classList.toggle('open', isOpen);
          var sub = box.querySelector('[data-sub="' + key + '"]');
          var leaf = box.querySelector('[data-leaf="' + key + '"]');
          if (sub) sub.classList.toggle('open', isOpen);
          if (leaf) leaf.classList.toggle('open', isOpen);
        });
      });
    }
    // 知识点点击进详情（树与搜索结果通用）
    box.querySelectorAll('.leaf-item').forEach(function (el) {
      el.addEventListener('click', function () { backTarget = 'study'; detailNo = el.dataset.no; view = 'detail'; render(); });
    });
  }

  /* ---------------- 渲染：详情 ---------------- */
  function renderDetail() {
    var it = itemByNo(detailNo);
    if (!it) { view = 'study'; render(); return; }
    qOpenTime = Date.now();
    var n = getScore(it.no);
    var sd = deriveStatus(it.no);
    var mastered = sd.correct >= MASTER_CORRECT;
    var backLabel = backTarget === 'wrong' ? '‹ 返回错题重练' : (backTarget === 'review' ? '‹ 返回今日复习' : '‹ 返回自由学习');
    var html = '';
    html += '<button class="back" id="back">' + backLabel + '</button>';
    html += '<div class="card">';
    html += '<div class="card-head"><span class="no">' + esc(it.no) + '</span><span class="kp">' + esc(it.kp) + '</span>' + (mastered ? '<span class="master-flag">✓ 已掌握</span>' : '') + '</div>';
    if (!it.pinyin) { html += '<div class="q">' + esc(it.q) + '</div>'; }
    if (it.pinyin) { html += '<div class="q-actions"><button class="btn dict" id="dict">▶ 开始听写</button></div><div class="dict-status" id="dictstatus"></div>'; }
    html += '<button class="btn" id="toggle">显示答案</button>';
    html += '<div class="ans" id="ans">' + esc(it.a) + '</div>';
    html += '<div class="score-row" id="row"><div class="score"><span class="num ' + numCls(n) + '" id="num">' + n + '</span><span class="lbl">分</span></div><div class="judge"><button class="jbtn ok" id="jok">✓ 正确</button><button class="jbtn no" id="jno">✗ 错误</button></div></div>';
    if (it.pinyin) {
      var ws = splitWords(it.pinyin);
      html += '<div class="dict-words">' + ws.map(function (w) { return '<span class="w">' + esc(w) + '</span>'; }).join('') + '</div>';
    }
    html += '</div>';
    mainEl.innerHTML = html;

    $('back').addEventListener('click', function () { stopDictation(); view = backTarget || 'study'; detailNo = null; render(); });
    var dictBtn = $('dict');
    if (dictBtn) dictBtn.addEventListener('click', function () { startDictation(splitWords(it.pinyin || ''), it.no); });
    $('toggle').addEventListener('click', function () {
      stopDictation();
      var ans = $('ans'), row = $('row'), open = !ans.classList.contains('show');
      ans.classList.toggle('show', open); row.classList.toggle('show', open);
      this.textContent = open ? '收起答案' : '显示答案'; this.classList.toggle('open', open);
    });
    function judge(delta) {
      addEvent(it.no, delta, Date.now() - qOpenTime);
      var n2 = getScore(it.no);
      var numEl = $('num'); numEl.textContent = n2; numEl.className = 'num ' + numCls(n2);
      numEl.style.transform = 'scale(1.18)'; setTimeout(function () { numEl.style.transform = 'scale(1)'; }, 130);
      if (backTarget === 'review' || backTarget === 'wrong') { setTimeout(function () { view = backTarget; detailNo = null; render(); }, 600); }
    }
    $('jok').addEventListener('click', function () { judge(1); });
    $('jno').addEventListener('click', function () { judge(-1); });
  }

  /* ---------------- 事件记录 ---------------- */
  function addEvent(no, delta, dur) {
    var ev = { no: no, d: delta, t: Date.now() };
    if (dur) ev.dur = dur;
    events.push(ev); computeScores(); saveEvents();
  }

  /* ---------------- 导出 / 导入进度 ---------------- */
  function exportProgress() {
    var data = { lib: currentLib, name: lib().name, exportedAt: new Date().toISOString(), events: events };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = '知识点进度_' + currentLib + '_' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function openImport() {
    $('importModal').classList.add('show');
    var inp = $('importFile'); if (inp) inp.value = '';
    $('importErr').textContent = '';
  }
  function doImport() {
    var inp = $('importFile');
    if (!inp || !inp.files || !inp.files.length) { $('importErr').textContent = '请先选择导出的进度文件'; return; }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var obj = JSON.parse(fr.result);
        if (!obj || !Array.isArray(obj.events)) throw new Error('文件格式不正确');
        var validNos = items().map(function (it) { return it.no; });
        var seen = {};
        events.forEach(function (e) { seen[e.t + '_' + e.no] = true; });
        obj.events.forEach(function (e) { if (validNos.indexOf(e.no) !== -1 && !seen[e.t + '_' + e.no]) { events.push(e); seen[e.t + '_' + e.no] = true; } });
        computeScores(); saveEvents();
        $('importModal').classList.remove('show');
        render();
      } catch (err) { $('importErr').textContent = '导入失败：' + err.message; }
    };
    fr.onerror = function () { $('importErr').textContent = '读取文件失败'; };
    fr.readAsText(inp.files[0]);
  }

  /* ---------------- 库切换 ---------------- */
  function renderLibList() {
    var box = $('libList');
    box.innerHTML = libOrder.map(function (k) {
      var L = LIBS[k]; var cnt = (L.items || []).length;
      return '<div class="lib-opt' + (k === currentLib ? ' active' : '') + '" data-k="' + esc(k) + '"><div>' + esc(L.name) + '</div><div class="meta">' + (cnt > 0 ? cnt + ' 条知识点' : '暂无内容') + '</div></div>';
    }).join('');
    box.querySelectorAll('.lib-opt').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.dataset.k;
        if (k === currentLib) { $('libModal').classList.remove('show'); return; }
        currentLib = k; loadEvents(); computeScores();
        libNameEl.textContent = LIBS[k].name;
        $('libModal').classList.remove('show');
        view = (LIBS[k].items || []).length ? 'review' : 'study';
        searchKw = ''; openState = {};
        render();
      });
    });
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    stopDictation();
    libNameEl.textContent = lib().name;
    if ((lib().items || []).length === 0 && view !== 'study') { view = 'study'; }
    if (view === 'detail') renderDetail();
    else if (view === 'review') renderReview();
    else if (view === 'wrong') renderWrong();
    else renderStudy();
    document.querySelectorAll('.viewtab').forEach(function (t) { t.classList.toggle('active', t.dataset.v === view); });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadEvents(); computeScores();
    document.querySelectorAll('.viewtab').forEach(function (t) {
      t.addEventListener('click', function () { stopDictation(); view = t.dataset.v; searchKw = ''; render(); });
    });
    $('libSwitch').addEventListener('click', function () { renderLibList(); $('libModal').classList.add('show'); });
    $('libCancel').addEventListener('click', function () { $('libModal').classList.remove('show'); });
    $('libModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });
    $('importCancel').addEventListener('click', function () { $('importModal').classList.remove('show'); });
    $('importConfirm').addEventListener('click', doImport);
    $('importModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });
    view = (lib().items || []).length ? 'review' : 'study';
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
