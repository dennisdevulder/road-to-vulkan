// app.js — small vanilla helpers for the learning hub.
// No frameworks. No build step.

(function () {
  // ── Topic switching ────────────────────────────────────────────────────
  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('[data-topic-page]');

  function showTopic(id) {
    pages.forEach((p) => p.classList.toggle('is-active', p.dataset.topicPage === id));
    navItems.forEach((n) => n.classList.toggle('is-active', n.dataset.topic === id));
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }

  navItems.forEach((item) => {
    item.addEventListener('click', () => showTopic(item.dataset.topic));
  });

  // initial
  const initial = (location.hash && location.hash.slice(1)) || 'geometry-of-light';
  if (document.querySelector(`[data-topic-page="${initial}"]`)) {
    showTopic(initial);
  } else {
    showTopic('geometry-of-light');
  }

  // ── Search ─────────────────────────────────────────────────────────────
  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('.nav-section').forEach((sec) => {
      let any = false;
      sec.querySelectorAll('.nav-item').forEach((item) => {
        const txt = item.textContent.toLowerCase();
        const match = !q || txt.includes(q);
        item.classList.toggle('is-hidden', !match);
        if (match) any = true;
      });
      sec.classList.toggle('is-hidden', !any);
    });
  });

  // ── Mark complete + sidebar progress ───────────────────────────────────
  const totalEl = document.getElementById('progress-total');
  const countEl = document.getElementById('progress-count');
  const fillEl  = document.getElementById('progress-fill');
  totalEl.textContent = navItems.length;

  const completed = new Set();
  function refreshProgress() {
    countEl.textContent = completed.size;
    fillEl.style.width = (completed.size / navItems.length) * 100 + '%';
    navItems.forEach((n) => {
      n.classList.toggle('is-complete', completed.has(n.dataset.topic));
    });
  }
  refreshProgress();

  document.querySelectorAll('[data-complete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.complete;
      if (completed.has(id)) {
        completed.delete(id);
        btn.classList.remove('is-on');
        btn.querySelector('.btn-label').textContent = 'Mark as complete';
      } else {
        completed.add(id);
        btn.classList.add('is-on');
        btn.querySelector('.btn-label').textContent = 'Completed';
      }
      refreshProgress();
    });
  });

  // ── Quiz ───────────────────────────────────────────────────────────────
  document.querySelectorAll('.quiz').forEach((quiz) => {
    const scoreEl = quiz.querySelector('.quiz-score-num');
    let score = 0;
    quiz.querySelectorAll('.quiz-q').forEach((q) => {
      const correctIdx = parseInt(q.dataset.answer, 10);
      const choices = q.querySelectorAll('.quiz-choice');
      choices.forEach((c, idx) => {
        c.addEventListener('click', () => {
          if (q.classList.contains('answered')) return;
          q.classList.add('answered');
          choices.forEach((cc, ii) => {
            cc.disabled = true;
            if (ii === correctIdx) cc.classList.add('is-correct');
            else if (ii === idx) cc.classList.add('is-wrong');
          });
          if (idx === correctIdx) {
            score++;
            scoreEl.textContent = score;
          }
        });
      });
    });
  });

  // ── Flashcards ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-deck]').forEach((deck) => {
    const data = JSON.parse(deck.querySelector('.flash-data').textContent);
    const card = deck.querySelector('.flash-card');
    const frontText = deck.querySelector('.flash-front .flash-text');
    const backText  = deck.querySelector('.flash-back .flash-text');
    const idxEl = deck.querySelector('.flash-idx');
    const totEl = deck.querySelector('.flash-total');
    const flipBtn = deck.querySelector('.flash-flip');
    const prevBtn = deck.querySelector('.flash-prev');
    const nextBtn = deck.querySelector('.flash-next');

    let i = 0;
    let flipped = false;
    totEl.textContent = data.length;

    function render() {
      frontText.textContent = data[i].front;
      backText.textContent  = data[i].back;
      idxEl.textContent = i + 1;
      card.classList.toggle('is-flipped', flipped);
      flipBtn.textContent = flipped ? 'Show term' : 'Show definition';
    }
    function flip() { flipped = !flipped; render(); }

    card.addEventListener('click', flip);
    flipBtn.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
    prevBtn.addEventListener('click', () => { i = (i - 1 + data.length) % data.length; flipped = false; render(); });
    nextBtn.addEventListener('click', () => { i = (i + 1) % data.length; flipped = false; render(); });

    render();
  });

  // ── Theme picker ───────────────────────────────────────────────────────
  const swatches = document.querySelectorAll('.theme-swatch');
  function setTheme(t) {
    document.body.dataset.theme = t;
    swatches.forEach((s) => s.classList.toggle('is-active', s.dataset.theme === t));
  }
  swatches.forEach((s) => s.addEventListener('click', () => setTheme(s.dataset.theme)));
  setTheme('paper');
})();
