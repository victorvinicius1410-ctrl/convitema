/**
 * Convite — modal de presentes (?G | ?M | ?P). Não abre sozinho ao carregar.
 * Com ?P, ?M ou ?G: ao abrir pelo botão, mostra só essa sugestão. Sem parâmetro: as três.
 */
(function () {
  "use strict";

  /**
   * Interpreta só links “limpos”: ?G, ?M, ?P (sem valor ou valor vazio).
   * @param {string} search window.location.search
   * @returns {'g'|'m'|'p'|null}
   */
  function parseGiftLetterFromSearch(search) {
    const raw = search.replace(/^\?/, "");
    if (!raw) return null;
    const segments = raw.split("&").filter(Boolean);
    for (const seg of segments) {
      const eq = seg.indexOf("=");
      const name = eq === -1 ? seg : seg.slice(0, eq);
      const val = eq === -1 ? undefined : seg.slice(eq + 1);
      if (!/^[gmp]$/i.test(name)) continue;
      if (val !== undefined && val !== "") continue;
      return /** @type {'g'|'m'|'p'} */ (name.toLowerCase());
    }
    return null;
  }

  /**
   * Remove parâmetros G/M/P de presente (sem valor ou vazios).
   * @param {string} search
   * @returns {string}
   */
  function removeGiftQueryParams(search) {
    const raw = search.replace(/^\?/, "");
    if (!raw) return "";
    const parts = raw.split("&").filter(Boolean).filter(function (seg) {
      const eq = seg.indexOf("=");
      const name = eq === -1 ? seg : seg.slice(0, eq);
      const val = eq === -1 ? undefined : seg.slice(eq + 1);
      if (!/^[gmp]$/i.test(name)) return true;
      if (val !== undefined && val !== "") return true;
      return false;
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  /** @type {HTMLDialogElement | null} */
  const modal = document.getElementById("gift-modal");
  const btnGift = document.getElementById("btn-gift");
  const introEl = document.getElementById("gift-modal-intro");
  const titleEl = document.getElementById("gift-modal-title");

  const GIFT_INTRO_ALL =
    "Três sugestões (P, M e G) — escolha o que fizer sentido para você.";
  const GIFT_INTRO_ONE = "Esta é a sugestão e apenas um guia para você.";
  const GIFT_TITLE_ALL = "Sugestões de presente";
  const GIFT_TITLE_ONE = "Sugestão de presente";

  /**
   * Com ?P / ?M / ?G mostra só o item desse tamanho; sem parâmetro, mostra os três.
   * @param {'g'|'m'|'p'|null} filterKey
   */
  function applyGiftListFilter(filterKey) {
    if (!modal) return;
    const showOne = filterKey !== null && filterKey !== undefined;
    modal.querySelectorAll(".gift-modal__item").forEach(function (li) {
      const k = li.getAttribute("data-gift-key");
      if (!showOne) {
        li.hidden = false;
      } else {
        li.hidden = k !== filterKey;
      }
    });
    if (introEl) {
      introEl.textContent = showOne ? GIFT_INTRO_ONE : GIFT_INTRO_ALL;
    }
    if (titleEl) {
      titleEl.textContent = showOne ? GIFT_TITLE_ONE : GIFT_TITLE_ALL;
    }
  }

  /**
   * @param {'g'|'m'|'p'|null} key
   */
  function highlightGiftRow(key) {
    if (!modal) return;
    modal.querySelectorAll(".gift-modal__item").forEach(function (li) {
      const k = li.getAttribute("data-gift-key");
      li.classList.toggle("gift-modal__item--highlight", key !== null && k === key);
    });
    if (key) {
      const target = modal.querySelector('[data-gift-key="' + key + '"]');
      if (target && !target.hidden && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function afterGiftDialogClosed() {
    const u = new URL(window.location.href);
    const newSearch = removeGiftQueryParams(u.search);
    if (newSearch !== u.search) {
      window.history.replaceState(null, "", `${u.origin}${u.pathname}${newSearch}${u.hash}`);
    }
    if (btnGift && document.body.classList.contains("state-invite")) {
      try {
        btnGift.focus();
      } catch (e) {
        /* ignorar */
      }
    }
  }

  /**
   * @param {'g'|'m'|'p'|null} [highlightKey]
   */
  function openGiftModal(highlightKey) {
    if (!modal) return;
    applyGiftListFilter(highlightKey || null);
    highlightGiftRow(highlightKey || null);
    if (typeof modal.showModal === "function") {
      modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }
    const closeBtn = modal.querySelector(".gift-modal__close");
    if (closeBtn) closeBtn.focus();
  }

  function closeGiftModal() {
    if (!modal) return;
    if (typeof modal.close === "function") {
      modal.close();
    } else {
      modal.removeAttribute("open");
      afterGiftDialogClosed();
    }
  }

  if (modal && typeof modal.addEventListener === "function") {
    modal.addEventListener("close", afterGiftDialogClosed);
  }

  if (btnGift && modal) {
    btnGift.addEventListener("click", function (e) {
      e.preventDefault();
      const key = parseGiftLetterFromSearch(window.location.search);
      openGiftModal(key);
    });
  }

  if (modal) {
    modal.querySelectorAll("[data-gift-close]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        closeGiftModal();
      });
    });
  }

  window.addEventListener("popstate", function () {
    if (!modal || !modal.open) return;
    const key = parseGiftLetterFromSearch(window.location.search);
    applyGiftListFilter(key || null);
    highlightGiftRow(key || null);
  });
})();

/**
 * Trilha de fundo — desbloqueio sem interferir com o <dialog> de presentes.
 */
(function () {
  "use strict";

  const audio = document.getElementById("invite-bg-audio");
  if (!audio) return;

  audio.volume = 0.38;

  let started = false;

  function tryPlay() {
    if (started) return;
    const p = audio.play();
    if (p !== undefined) {
      p.then(function () {
        started = true;
      }).catch(function () {});
    }
  }

  window.addEventListener("invite:music", tryPlay);

  function unlockOnce() {
    tryPlay();
    document.removeEventListener("pointerdown", unlockOnce, false);
  }

  document.addEventListener("pointerdown", unlockOnce, false);
})();
