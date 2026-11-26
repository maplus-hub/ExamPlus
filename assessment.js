(() => {
  "use strict";

  const STORAGE_KEY = "examplus-assessment-v1";
  const DEFAULT_DURATION_SECONDS = 90 * 60;
  const state = { data: null, answers: {}, name: "", klass: "", timerId: null, remaining: DEFAULT_DURATION_SECONDS };

  const elements = {
    startScreen: document.getElementById("start-screen"),
    name: document.getElementById("participant-name"),
    klass: document.getElementById("participant-class"),
    startError: document.getElementById("start-error"),
    startButton: document.getElementById("start-button"),
    examScreen: document.getElementById("exam-screen"),
    participantSummary: document.getElementById("participant-summary"),
    timer: document.getElementById("timer"),
    progressList: document.getElementById("progress-list"),
    content: document.getElementById("exam-content"),
    saveButton: document.getElementById("save-button"),
    submitButton: document.getElementById("submit-button"),
    dialog: document.getElementById("submit-dialog"),
    submitSummary: document.getElementById("submit-summary"),
    cancelSubmit: document.getElementById("cancel-submit"),
    confirmSubmit: document.getElementById("confirm-submit"),
    successScreen: document.getElementById("success-screen"),
    backButton: document.getElementById("back-button"),
  };

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  function loadSavedState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && saved.answers) {
        state.answers = saved.answers;
        if (typeof saved.name === "string") elements.name.value = saved.name;
        if (typeof saved.klass === "string") elements.klass.value = saved.klass;
      }
    } catch (_) {}
  }

  function saveProgress(showFeedback) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      name: elements.name.value.trim(),
      klass: elements.klass.value,
      answers: state.answers,
      remaining: state.remaining,
      startedAt: Date.now(),
    }));
    if (showFeedback) {
      elements.saveButton.textContent = "Tersimpan";
      setTimeout(() => { elements.saveButton.textContent = "Simpan progres"; }, 1200);
    }
  }

  function updateAnswer(key, value) {
    state.answers[key] = value;
  }

  function checkboxHtml(item, index) {
    const key = `entry_${item.entry}`;
    const selected = Array.isArray(state.answers[key]) ? state.answers[key] : [];
    return item.options.map((option, optionIndex) => `
      <label class="option">
        <input type="checkbox" data-key="${key}" value="${escapeHtml(option)}"
          ${selected.includes(option) ? "checked" : ""} />
        <span>${escapeHtml(option)}</span>
      </label>
    `).join("");
  }

  function radioHtml(item) {
    const key = `entry_${item.entry}`;
    const selected = state.answers[key] || "";
    return item.options.map(option => `
      <label class="option">
        <input type="radio" name="${key}" data-key="${key}" value="${escapeHtml(option)}"
          ${selected === option ? "checked" : ""} />
        <span>${escapeHtml(option)}</span>
      </label>
    `).join("");
  }

  function renderQuestion(item, sectionIndex, questionIndex) {
    const key = `entry_${item.entry}`;
    const number = item.title.match(/^(\d+)/);
    const title = number
      ? item.title.replace(/^(\d+)/, "<strong>$1.</strong>")
      : escapeHtml(item.title);

    let control = "";
    if (item.type === "radio") {
      control = `<div class="option-grid">${radioHtml(item)}</div>`;
    } else if (item.type === "checkbox") {
      control = `<div class="option-grid">${checkboxHtml(item)}</div>`;
    } else if (item.type === "select") {
      const selected = state.answers[key] || "";
      control = `<select data-key="${key}"><option value="">Pilih jawaban</option>${item.options.map(option =>
        `<option ${selected === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
    } else if (item.type === "essay") {
      control = `<textarea data-key="${key}" placeholder="Tuliskan jawaban analisismu...">${escapeHtml(state.answers[key] || "")}</textarea>`;
    } else if (item.type === "text") {
      control = `<input type="text" data-key="${key}" value="${escapeHtml(state.answers[key] || "")}" placeholder="Nama lengkap" />`;
    }

    return `
      <article class="question" data-section="${sectionIndex}" data-question="${questionIndex}">
        <p class="question-title">${title}</p>
        ${control}
      </article>`;
  }

  function renderExam() {
    elements.content.innerHTML = state.data.sections.map((section, sectionIndex) => `
      <section class="exam-section" id="section-${sectionIndex}" data-section="${sectionIndex}">
        <h2>${escapeHtml(section.title)}</h2>
        ${section.items.map((item, questionIndex) => renderQuestion(item, sectionIndex, questionIndex)).join("")}
      </section>
    `).join("");

    elements.progressList.innerHTML = state.data.sections.map((section, sectionIndex) => `
      <button class="progress-item ${sectionIndex === 0 ? "active" : ""}" type="button"
        data-target="section-${sectionIndex}">${escapeHtml(section.title.replace(/^BAGIAN [IVX]+:\s*/i, ""))}</button>
    `).join("");

    elements.content.querySelectorAll("[data-key]").forEach(control => {
      const eventName = control.type === "checkbox" || control.type === "radio" ? "change" : "input";
      control.addEventListener(eventName, () => {
        if (control.type === "checkbox") {
          const key = control.dataset.key;
          const values = [...elements.content.querySelectorAll(`input[type="checkbox"][data-key="${key}"]:checked`)]
            .map(input => input.value);
          updateAnswer(key, values);
        } else if (control.type === "radio") {
          if (control.checked) updateAnswer(control.dataset.key, control.value);
        } else {
          updateAnswer(control.dataset.key, control.value);
        }
        saveProgress(false);
        updateProgress();
      });
    });

    elements.progressList.querySelectorAll("[data-target]").forEach(button => {
      button.addEventListener("click", () => {
        document.getElementById(button.dataset.target).scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function updateProgress() {
    state.data.sections.forEach((section, sectionIndex) => {
      const completed = section.items.every(item => {
        const value = state.answers[`entry_${item.entry}`];
        return Array.isArray(value) ? value.length > 0 : Boolean(value && String(value).trim());
      });
      const button = elements.progressList.querySelectorAll(".progress-item")[sectionIndex];
      if (button) button.classList.toggle("done", completed);
    });
  }

  function formatTimer(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(value => String(value).padStart(2, "0")).join(":");
  }

  function startTimer() {
    const render = () => {
      elements.timer.textContent = formatTimer(state.remaining);
      elements.timer.parentElement.classList.toggle("danger", state.remaining <= 300);
      if (state.remaining <= 0) {
        clearInterval(state.timerId);
        submitAnswers();
      }
      state.remaining -= 1;
    };
    render();
    state.timerId = setInterval(render, 1000);
  }

  function answerCount() {
    let count = 0;
    let total = 0;
    state.data.sections.forEach(section => {
      section.items.forEach(item => {
        if (item.entry) total += 1;
        const value = state.answers[`entry_${item.entry}`];
        if (Array.isArray(value) ? value.length : Boolean(value && String(value).trim())) count += 1;
      });
    });
    return { count, total };
  }

  function submitAnswers() {
    if (!state.data) return;
    elements.confirmSubmit.disabled = true;
    elements.confirmSubmit.textContent = "Mengirim...";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = state.data.action;
    form.target = "gform-submit-frame";
    form.style.display = "none";

    Object.entries(state.answers).forEach(([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      values.forEach(answer => {
        if (!answer) return;
        const input = document.createElement("input");
        input.name = key.replace("entry_", "entry.");
        input.value = answer;
        form.appendChild(input);
      });
    });

    const frame = document.createElement("iframe");
    frame.name = "gform-submit-frame";
    frame.style.display = "none";
    document.body.appendChild(frame);
    document.body.appendChild(form);
    frame.addEventListener("load", () => finishSubmission(), { once: true });
    form.submit();

    setTimeout(() => finishSubmission(), 3500);
  }

  function finishSubmission() {
    if (elements.successScreen.classList.contains("hidden")) {
      clearInterval(state.timerId);
      localStorage.removeItem(STORAGE_KEY);
      elements.dialog.close();
      elements.examScreen.classList.add("hidden");
      elements.successScreen.classList.remove("hidden");
    }
  }

  elements.startButton.addEventListener("click", () => {
    const name = elements.name.value.trim();
    const klass = elements.klass.value;
    if (!name) {
      elements.startError.textContent = "Isi nama lengkap terlebih dahulu.";
      elements.name.focus();
      return;
    }
    if (!klass) {
      elements.startError.textContent = "Pilih kelas terlebih dahulu.";
      elements.klass.focus();
      return;
    }
    state.name = name;
    state.klass = klass;
    updateAnswer("entry_1493437007", name);
    updateAnswer("entry_1096851284", klass);
    elements.participantSummary.textContent = `${name} · Kelas ${klass}`;
    elements.startScreen.classList.add("hidden");
    elements.examScreen.classList.remove("hidden");
    renderExam();
    updateProgress();
    saveProgress(false);
    startTimer();
  });

  elements.saveButton.addEventListener("click", () => saveProgress(true));

  elements.submitButton.addEventListener("click", () => {
    const { count, total } = answerCount();
    elements.submitSummary.textContent = `${count} dari ${total} butir respons telah terisi.`;
    elements.dialog.showModal();
  });

  elements.cancelSubmit.addEventListener("click", () => elements.dialog.close());
  elements.confirmSubmit.addEventListener("click", event => {
    event.preventEvent?.();
  });
  elements.dialog.addEventListener("close", () => {
    if (elements.dialog.returnValue === "confirm") submitAnswers();
  });

  elements.backButton.addEventListener("click", () => {
    elements.successScreen.classList.add("hidden");
    elements.startScreen.classList.remove("hidden");
  });

  fetch("./assessment-data.json")
    .then(response => {
      if (!response.ok) throw new Error("Data soal tidak dapat dimuat.");
      return response.json();
    })
    .then(data => {
      state.data = data;
      loadSavedState();
    })
    .catch(error => {
      elements.startError.textContent = error.message;
      elements.startButton.disabled = true;
    });
})();
