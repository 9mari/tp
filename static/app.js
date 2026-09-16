/* ============================================================
   WARDOGS 出勤投票 — 交互层
   ============================================================ */
(() => {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const COLORS = { yes: "#45f0a6", maybe: "#ffd166", no: "#ff6b8b" };

  const el = {
    options:   $("#options"),
    name:      $("#name"),
    nameLen:   $("#nameLen"),
    note:      $("#note"),
    submit:    $("#submitBtn"),
    withdraw:  $("#withdrawBtn"),
    bars:      $("#bars"),
    verdict:   $("#verdict"),
    people:    $("#people"),
    peopleEmpty: $("#peopleEmpty"),
    peopleHint:  $("#peopleHint"),
    myHint:    $("#myHint"),
    totalNum:  $("#totalNum"),
    yesNum:    $("#yesNum"),
    deadline:  $("#deadlineTxt"),
    updatedAt: $("#updatedAt"),
    toasts:    $("#toasts"),
    spotlight: $("#spotlight"),
    admin:     $("#adminBtn"),
    liveLabel: $("#liveLabel"),
  };

  let state = JSON.parse($("#bootstrap").textContent);
  let picked = state.me ? state.me.choice : null;
  let busy = false;

  /* ---------------------------------------------------------- 工具 */
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const labelOf = (id) => (state.options.find((o) => o.id === id) || {}).label || id;

  function toast(msg, kind = "info") {
    const icon = kind === "ok" ? "✅" : kind === "err" ? "⚠️" : "💬";
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add("out");
      setTimeout(() => node.remove(), 360);
    }, 3200);
  }

  function countUp(node, to) {
    const from = Number(node.dataset.v || 0);
    if (from === to) { node.textContent = to; return; }
    node.dataset.v = to;
    const t0 = performance.now(), dur = 620;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const timeAgo = (ts) => {
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "刚刚";
    if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
    return `${Math.floor(d / 86400)} 天前`;
  };

  /* ---------------------------------------------------------- 渲染：选项 */
  function renderOptions() {
    el.options.innerHTML = state.options
      .map(
        (o) => `
      <button class="opt" type="button" data-id="${o.id}" aria-pressed="false"
              style="--c:${COLORS[o.id] || "#7c5cff"}">
        <span class="halo"></span>
        <span class="emoji">${o.emoji}</span>
        <span class="lbl">${esc(o.label)}</span>
        <span class="dsc">${esc(o.desc)}</span>
        <span class="tick"></span>
      </button>`
      )
      .join("");

    $$(".opt", el.options).forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.closed) return toast("投票已经截止啦", "err");
        picked = btn.dataset.id;
        syncPicked();
        ripple(btn);
      });
    });
    syncPicked();
  }

  function syncPicked() {
    $$(".opt", el.options).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.id === picked))
    );
    el.submit.querySelector(".btn-text").textContent = state.me
      ? "更新我的选择"
      : "投出这一票";
  }

  function ripple(host) {
    const r = document.createElement("span");
    Object.assign(r.style, {
      position: "absolute", left: "50%", top: "50%", width: "6px", height: "6px",
      borderRadius: "50%", background: "rgba(255,255,255,.5)",
      transform: "translate(-50%,-50%) scale(1)", pointerEvents: "none",
      transition: "transform .6s cubic-bezier(.22,1,.36,1), opacity .6s",
    });
    host.appendChild(r);
    requestAnimationFrame(() => {
      r.style.transform = "translate(-50%,-50%) scale(46)";
      r.style.opacity = "0";
    });
    setTimeout(() => r.remove(), 640);
  }

  /* ---------------------------------------------------------- 渲染：结果 */
  function renderResults() {
    const sorted = [...state.results];
    el.bars.innerHTML = sorted
      .map(
        (r) => `
      <div class="bar-row" style="--c:${COLORS[r.id] || "#7c5cff"}">
        <div class="bar-top">
          <span class="dot"></span>
          <span class="nm">${r.emoji} ${esc(r.label)}</span>
          <span class="ct">${r.count} 票</span>
          <span class="pc">${r.percent}%</span>
        </div>
        <div class="track"><div class="fill" data-w="${r.percent}"></div></div>
      </div>`
      )
      .join("");

    requestAnimationFrame(() => {
      $$(".fill", el.bars).forEach((f, i) => {
        setTimeout(() => (f.style.width = `${Math.max(Number(f.dataset.w), f.dataset.w > 0 ? 3 : 0)}%`), 90 * i);
      });
    });

    // 结论
    const total = state.total;
    let html;
    if (!total) {
      html = `<span class="big">🕳️</span><span>还没人投票 —— 谁先来定个调？</span>`;
    } else {
      const top = [...state.results].sort((a, b) => b.count - a.count);
      const tie = top[1] && top[1].count === top[0].count;
      const yes = state.results.find((r) => r.id === "yes").count;
      const maybe = state.results.find((r) => r.id === "maybe").count;
      if (tie) {
        html = `<span class="big">⚖️</span><span>目前 <b>${esc(top[0].label)}</b> 和 <b>${esc(top[1].label)}</b> 打平，再拉个人来投票吧。</span>`;
      } else if (top[0].id === "yes") {
        html = `<span class="big">🔥</span><span>局势是 <b>开</b>！确定上号 <b>${yes}</b> 人${maybe ? `，随缘 ${maybe} 人` : ""} —— 可以约时间了。</span>`;
      } else if (top[0].id === "maybe") {
        html = `<span class="big">🎲</span><span>大多数人 <b>随缘</b>，等一个带头的喊开。</span>`;
      } else {
        html = `<span class="big">🌙</span><span>多数人 <b>今晚不玩</b>，改天再约。</span>`;
      }
    }
    el.verdict.innerHTML = html;

    countUp(el.totalNum, total);
    countUp(el.yesNum, state.results.find((r) => r.id === "yes").count);
    el.updatedAt.textContent = total
      ? `最近更新 ${timeAgo(Math.max(...state.voters.map((v) => v.at)))}`
      : "暂无数据";
  }

  /* ---------------------------------------------------------- 渲染：名单 */
  function renderPeople() {
    const vs = [...state.voters].reverse();
    el.peopleEmpty.hidden = vs.length > 0;
    el.peopleHint.textContent = vs.length ? `${vs.length} 人` : "";
    el.people.innerHTML = vs
      .map(
        (v, i) => `
      <div class="chip ${v.isMe ? "me" : ""}" style="--c:${COLORS[v.choice] || "#7c5cff"}; animation-delay:${i * 0.035}s"
           title="${esc(v.name)} · ${esc(labelOf(v.choice))}">
        <span class="av">${esc([...v.name][0] || "?")}</span>
        <span class="who">${esc(v.name)}</span>
        ${v.note ? `<span class="say">“${esc(v.note)}”</span>` : ""}
      </div>`
      )
      .join("");
  }

  /* ---------------------------------------------------------- 渲染：自身状态 */
  function renderMe() {
    if (state.me) {
      el.myHint.innerHTML = `已投 <b style="color:${COLORS[state.me.choice]}">${esc(labelOf(state.me.choice))}</b> · 可随时修改`;
      el.withdraw.hidden = false;
      if (!el.name.value) el.name.value = state.me.name;
      if (!el.note.value) el.note.value = state.me.note || "";
    } else {
      el.myHint.textContent = "还没投票";
      el.withdraw.hidden = true;
    }
    el.nameLen.textContent = [...el.name.value].length;

    if (state.closed) {
      el.submit.disabled = true;
      el.submit.querySelector(".btn-text").textContent = "投票已截止";
      el.liveLabel.textContent = "投票已截止";
    }

    if (state.deadline) {
      const d = new Date(state.deadline * 1000);
      el.deadline.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }

  function renderAll() {
    renderResults();
    renderPeople();
    renderMe();
    syncPicked();
  }

  /* ---------------------------------------------------------- 请求 */
  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "网络开小差了，再试一次");
    return data;
  }

  async function submit() {
    if (busy) return;
    const name = el.name.value.trim();
    if (!picked) {
      toast("先选一个选项", "err");
      el.options.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" },
         { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
        { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" }
      );
      return;
    }
    if (!name) {
      toast("写上名字，方便点人头", "err");
      el.name.classList.add("bad");
      el.name.focus();
      setTimeout(() => el.name.classList.remove("bad"), 600);
      return;
    }

    busy = true;
    el.submit.classList.add("loading");
    el.submit.disabled = true;
    try {
      const wasVoted = !!state.me;
      const data = await post("/api/vote", { name, choice: picked, note: el.note.value.trim() });
      state = data;
      picked = state.me ? state.me.choice : picked;
      renderAll();
      toast(wasVoted ? "已更新你的选择" : `投票成功 · ${labelOf(picked)}`, "ok");
      if (picked === "yes") burst();
    } catch (e) {
      toast(e.message, "err");
      el.name.classList.add("bad");
      setTimeout(() => el.name.classList.remove("bad"), 600);
    } finally {
      busy = false;
      el.submit.classList.remove("loading");
      el.submit.disabled = !!state.closed;
    }
  }

  async function withdraw() {
    if (busy || !state.me) return;
    if (!confirm("撤回你的这一票？")) return;
    busy = true;
    try {
      state = await post("/api/withdraw");
      picked = null;
      renderAll();
      toast("已撤回", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    if (busy || document.hidden) return;
    try {
      const res = await fetch("/api/state", { credentials: "same-origin" });
      const data = await res.json();
      const changed = JSON.stringify(data.voters) !== JSON.stringify(state.voters);
      state = data;
      if (changed) renderAll();
      else { renderMe(); }
    } catch { /* 静默 */ }
  }

  /* ---------------------------------------------------------- 彩带 */
  const cvs = $("#confetti");
  const ctx = cvs.getContext("2d");
  let parts = [], raf = null;

  function fit() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cvs.width = innerWidth * dpr;
    cvs.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fit();
  addEventListener("resize", fit);

  function burst() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const palette = ["#45f0a6", "#31d0ff", "#7c5cff", "#ffd166", "#ff6b8b", "#ffffff"];
    for (let i = 0; i < 130; i++) {
      parts.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * 220,
        y: innerHeight * 0.42,
        vx: (Math.random() - 0.5) * 13,
        vy: -Math.random() * 15 - 5,
        w: 5 + Math.random() * 7,
        h: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: palette[(Math.random() * palette.length) | 0],
        life: 1,
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 60);
    parts.forEach((p) => {
      p.vy += 0.34;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.004;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (parts.length) raf = requestAnimationFrame(tick);
    else { ctx.clearRect(0, 0, innerWidth, innerHeight); raf = null; }
  }

  /* ---------------------------------------------------------- 杂项交互 */
  // 鼠标光斑
  let sx = -9999, sy = -9999, cx = sx, cy = sy;
  addEventListener("pointermove", (e) => { sx = e.clientX; sy = e.clientY; }, { passive: true });
  (function follow() {
    cx += (sx - cx) * 0.08;
    cy += (sy - cy) * 0.08;
    el.spotlight.style.transform = `translate3d(${cx - 320}px, ${cy - 320}px, 0)`;
    requestAnimationFrame(follow);
  })();

  // 卡片 3D 倾斜
  $$(".panel").forEach((p) => {
    p.addEventListener("pointermove", (e) => {
      const r = p.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -2.2;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 2.2;
      p.style.transform = `perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    p.addEventListener("pointerleave", () => { p.style.transform = ""; });
  });

  el.submit.addEventListener("click", submit);
  el.withdraw.addEventListener("click", withdraw);
  el.name.addEventListener("input", () => { el.nameLen.textContent = [...el.name.value].length; });
  [el.name, el.note].forEach((i) =>
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); })
  );
  document.addEventListener("keydown", (e) => {
    if (["1", "2", "3"].includes(e.key) && document.activeElement.tagName !== "INPUT") {
      const b = $$(".opt", el.options)[Number(e.key) - 1];
      if (b) b.click();
    }
  });

  el.admin.addEventListener("click", async () => {
    const token = prompt("输入管理口令以清空所有投票：");
    if (!token) return;
    try {
      await post("/api/admin/reset", { token });
      toast("已清空全部投票", "ok");
      await refresh();
      picked = null;
      renderAll();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  /* ---------------------------------------------------------- 启动 */
  renderOptions();
  renderAll();
  setInterval(refresh, 5000);
})();
