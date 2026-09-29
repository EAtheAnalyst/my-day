const { useState, useEffect, useRef, useCallback } = React;

// ---------- Helpers ----------

function toDayString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayString() {
  return toDayString(new Date());
}

function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return toDayString(new Date(y, m - 1, d + delta));
}

function prettyDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
}

function currentTime() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && path !== "/login") {
    // Logged out (e.g. password changed): reloading shows the login screen
    window.location.reload();
  }
  if (!res.ok) {
    let message = `Something went wrong (${res.status})`;
    try { message = (await res.json()).detail || message; } catch {}
    throw new Error(message);
  }
  return res.json();
}

function shortDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

const REMINDERS = [
  { kind: "morning", setting: "morning_time", title: "Good morning! ☀️", body: "Time to plan today's to-do list." },
  { kind: "afternoon", setting: "afternoon_time", title: "Afternoon check-in 🌤️", body: "How is your day going? Check your progress." },
  { kind: "night", setting: "night_time", title: "Evening review 🌙", body: "Take a few minutes to review your day." },
];

// ---------- Small components ----------

function ProgressBar({ todos, large }) {
  const total = todos.length;
  const done = todos.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const top = todos.filter((t) => t.priority);
  const topDone = top.filter((t) => t.done).length;
  let message = "Add some tasks to get started";
  if (total) {
    if (pct === 100) message = "All done — amazing work! 🎉";
    else if (pct >= 50) message = "Over halfway there, keep going!";
    else if (pct > 0) message = "Good start, keep it up!";
    else message = "Let's knock out the first one";
  }
  return (
    <div className={`progress ${large ? "progress-large" : ""}`}>
      <div className="progress-top">
        <span className="progress-label">Today's progress</span>
        <span className="progress-count">{done} / {total} · {pct}%</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-bottom">
        <span className="progress-message">{message}</span>
        {top.length > 0 && (
          <span className={`top-count ${topDone === top.length ? "complete" : ""}`}>
            ⭐ Top tasks: {topDone} / {top.length}
          </span>
        )}
      </div>
    </div>
  );
}

function Modal({ title, children, onClose, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddTodoForm({ onAdd, autoFocus }) {
  const [text, setText] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd(text);
    setText("");
  };
  return (
    <form className="add-form" onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What do you need to do?"
        autoFocus={autoFocus}
      />
      <button type="submit" className="btn primary">Add</button>
    </form>
  );
}

// ---------- Todo list ----------

function StarButton({ todo, onPriority }) {
  return (
    <button
      className={`icon-btn star ${todo.priority ? "on" : ""}`}
      onClick={() => onPriority(todo)}
      aria-label={todo.priority ? "Remove from top tasks" : "Mark as top task"}
      title={todo.priority ? "Remove from top 3" : "Make this a top 3 task"}
    >
      {todo.priority ? "★" : "☆"}
    </button>
  );
}

function TodoList({ todos, setTodos, onToggle, onPriority, onDelete, onEdit, onReorder }) {
  const dragId = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= todos.length) return;
    const next = [...todos];
    [next[index], next[target]] = [next[target], next[index]];
    setTodos(next);
    onReorder(next);
  };

  const handleDragOver = (e, overId) => {
    e.preventDefault();
    const fromId = dragId.current;
    if (fromId === null || fromId === overId) return;
    const from = todos.findIndex((t) => t.id === fromId);
    const to = todos.findIndex((t) => t.id === overId);
    const next = [...todos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setTodos(next);
  };

  const saveEdit = (todo) => {
    const text = editText.trim();
    if (text && text !== todo.text) onEdit(todo, text);
    setEditingId(null);
  };

  if (!todos.length) {
    return <p className="empty">No tasks yet. Add your first one above.</p>;
  }

  return (
    <ul className="todo-list">
      {todos.map((todo, i) => (
        <li
          key={todo.id}
          className={`todo ${todo.done ? "done" : ""} ${todo.priority ? "top" : ""}`}
          draggable={editingId !== todo.id}
          onDragStart={() => (dragId.current = todo.id)}
          onDragOver={(e) => handleDragOver(e, todo.id)}
          onDragEnd={() => {
            dragId.current = null;
            onReorder(todos);
          }}
        >
          <span className="drag-handle" title="Drag to move">⋮⋮</span>
          <input
            type="checkbox"
            checked={!!todo.done}
            onChange={() => onToggle(todo)}
            aria-label="Mark done"
          />
          {editingId === todo.id ? (
            <input
              className="edit-input"
              value={editText}
              autoFocus
              onChange={(e) => setEditText(e.target.value)}
              onBlur={() => saveEdit(todo)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit(todo);
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span
              className="todo-text"
              title="Double-click to edit"
              onDoubleClick={() => {
                setEditingId(todo.id);
                setEditText(todo.text);
              }}
            >
              {todo.text}
            </span>
          )}
          <StarButton todo={todo} onPriority={onPriority} />
          <div className="todo-actions">
            <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === todos.length - 1} aria-label="Move down">↓</button>
            <button className="icon-btn danger" onClick={() => onDelete(todo)} aria-label="Delete">🗑</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- Notes ----------

// Only these tags are kept in formatted notes (pasted styles, links, scripts are removed)
const NOTE_TAGS = ["b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "br", "p", "div", "h3"];

function cleanHtml(html) {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: NOTE_TAGS, ALLOWED_ATTR: [] });
}

const FORMAT_BUTTONS = [
  { command: "bold", label: <b>B</b>, title: "Bold (Ctrl+B)" },
  { command: "italic", label: <i>I</i>, title: "Italic (Ctrl+I)" },
  { command: "underline", label: <u>U</u>, title: "Underline (Ctrl+U)" },
  { command: "strikeThrough", label: <s>S</s>, title: "Strikethrough" },
  { command: "formatBlock", value: "h3", label: "H", title: "Heading (click again to undo)" },
  { command: "insertUnorderedList", label: "• List", title: "Bullet list" },
  { command: "insertOrderedList", label: "1. List", title: "Numbered list" },
  { command: "removeFormat", label: "✕ Clear", title: "Clear formatting" },
];

function NoteEditor({ onSave }) {
  const editor = useRef(null);
  const [active, setActive] = useState({});
  const [empty, setEmpty] = useState(true);

  const refreshState = () => {
    const state = {};
    for (const b of FORMAT_BUTTONS) {
      if (b.command === "formatBlock") {
        state.formatBlock = document.queryCommandValue("formatBlock").toLowerCase() === "h3";
      } else if (b.command !== "removeFormat") {
        state[b.command] = document.queryCommandState(b.command);
      }
    }
    setActive(state);
    setEmpty(!editor.current.innerText.trim());
  };

  useEffect(() => {
    const onSelection = () => {
      if (editor.current && editor.current.contains(document.getSelection().anchorNode)) refreshState();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  const apply = (b) => {
    editor.current.focus();
    if (b.command === "formatBlock") {
      // Toggle heading on/off
      document.execCommand("formatBlock", false, active.formatBlock ? "div" : "h3");
    } else if (b.command === "removeFormat") {
      document.execCommand("removeFormat");
      document.execCommand("formatBlock", false, "div");
    } else {
      document.execCommand(b.command);
    }
    refreshState();
  };

  const save = () => {
    const html = cleanHtml(editor.current.innerHTML);
    if (!editor.current.innerText.trim()) return;
    onSave(html);
    editor.current.innerHTML = "";
    refreshState();
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  // Paste as clean formatted text (drops fonts, colours and links from websites)
  const onPaste = (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    if (html) {
      document.execCommand("insertHTML", false, cleanHtml(html));
    } else {
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    }
  };

  return (
    <div className="note-form">
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        {FORMAT_BUTTONS.map((b) => (
          <button
            key={b.command}
            type="button"
            className={`tool ${active[b.command] ? "on" : ""}`}
            title={b.title}
            aria-label={b.title}
            aria-pressed={!!active[b.command]}
            // mousedown + preventDefault keeps the text selection in the editor
            onMouseDown={(e) => { e.preventDefault(); apply(b); }}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div
        ref={editor}
        className={`note-editor rich ${empty ? "is-empty" : ""}`}
        contentEditable
        role="textbox"
        aria-label="New note"
        aria-multiline="true"
        data-placeholder="Capture a thought, idea, or anything on your mind…"
        onInput={refreshState}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="note-form-bottom">
        <span className="hint">Ctrl + Enter to save</span>
        <button type="button" className="btn primary" onClick={save}>Save note</button>
      </div>
    </div>
  );
}

function Notes({ notes, onAdd, onDelete }) {
  return (
    <div>
      <NoteEditor onSave={(html) => onAdd(html)} />
      {notes.length === 0 ? (
        <p className="empty">No notes yet.</p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id} className="note">
              {n.is_html ? (
                <div className="note-text rich" dangerouslySetInnerHTML={{ __html: cleanHtml(n.text) }} />
              ) : (
                <div className="note-text">{n.text}</div>
              )}
              <div className="note-meta">
                <span>{n.created_at.slice(11, 16)}</span>
                <button className="link-btn danger" onClick={() => onDelete(n)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Reminder / feature modals ----------

function YesterdayPopup({ review, onClose }) {
  return (
    <Modal title="A note from your past self 💬" onClose={onClose}>
      <p className="muted">On {prettyDay(review.day)}, you said you would do better at:</p>
      <blockquote className="quote">{review.do_better}</blockquote>
      <p>Keep this in mind as you go through today.</p>
      <div className="modal-footer">
        <button className="btn primary" onClick={onClose}>Got it 👍</button>
      </div>
    </Modal>
  );
}

function MorningModal({ todos, prevReview, onAdd, onPriority, onCarryOver, onClose }) {
  const topCount = todos.filter((t) => t.priority).length;
  return (
    <Modal title="Good morning! ☀️ Let's plan your day" onClose={onClose}>
      {prevReview && (
        <div className="callout">
          <strong>Remember to do better at:</strong> {prevReview.do_better}
        </div>
      )}
      <p className="muted">What are the most important things you want to get done today?</p>
      <AddTodoForm onAdd={onAdd} autoFocus />
      {todos.length > 0 && (
        <>
          <p className="pick-top">
            ⭐ Now star your <strong>top 3</strong> — the tasks that would make today a success.
            <span className="muted"> ({topCount}/3 picked)</span>
          </p>
          <ul className="mini-list">
            {todos.map((t) => (
              <li key={t.id} className={t.priority ? "top" : ""}>
                <StarButton todo={t} onPriority={onPriority} />
                <span>{t.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-footer">
        <button className="btn" onClick={onCarryOver}>Bring over yesterday's unfinished tasks</button>
        <button className="btn primary" onClick={onClose}>Let's go!</button>
      </div>
    </Modal>
  );
}

function AfternoonModal({ todos, onToggle, onClose }) {
  const remaining = todos.filter((t) => !t.done);
  return (
    <Modal title="Afternoon check-in 🌤️" onClose={onClose}>
      <ProgressBar todos={todos} large />
      {remaining.length > 0 ? (
        <>
          <p className="muted">Still to do — tick off anything you've finished:</p>
          <ul className="check-list">
            {remaining.map((t) => (
              <li key={t.id}>
                <label>
                  <input type="checkbox" checked={false} onChange={() => onToggle(t)} /> {t.text}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{todos.length ? "Everything is done. Great job!" : "You haven't added any tasks today yet."}</p>
      )}
      <div className="modal-footer">
        <button className="btn primary" onClick={onClose}>Back to it</button>
      </div>
    </Modal>
  );
}

const REVIEW_QUESTIONS = [
  { key: "went_well", label: "What went well today?", placeholder: "Wins, big or small…" },
  { key: "not_well", label: "What didn't go so well?", placeholder: "What got in the way?" },
  { key: "do_better", label: "What will I do better tomorrow?", placeholder: "One or two specific things. This will pop up tomorrow!" },
  { key: "grateful", label: "One thing I'm grateful for", placeholder: "Anything at all…" },
];

function ReviewModal({ day, todos, onClose }) {
  const [form, setForm] = useState({ went_well: "", not_well: "", do_better: "", grateful: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api(`/reviews/${day}`).then((r) => r && setForm(r));
  }, [day]);

  const save = async () => {
    await api(`/reviews/${day}`, { method: "PUT", body: form });
    setSaved(true);
    setTimeout(onClose, 700);
  };

  return (
    <Modal title={`Daily review 🌙 · ${prettyDay(day)}`} onClose={onClose} wide>
      <ProgressBar todos={todos} />
      {REVIEW_QUESTIONS.map((q) => (
        <label key={q.key} className="field">
          <span className={q.key === "do_better" ? "field-label highlight" : "field-label"}>{q.label}</span>
          <textarea
            rows={2}
            value={form[q.key] || ""}
            placeholder={q.placeholder}
            onChange={(e) => setForm({ ...form, [q.key]: e.target.value })}
          />
        </label>
      ))}
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>{saved ? "Saved ✓" : "Save review"}</button>
      </div>
    </Modal>
  );
}

function WeekModal({ today, onPick, onClose }) {
  const [end, setEnd] = useState(today);
  const [week, setWeek] = useState(null);
  useEffect(() => { api(`/week?end=${end}`).then(setWeek); }, [end]);

  const lessons = (week || []).filter((d) => d.review && d.review.do_better.trim());
  const totals = (week || []).reduce(
    (acc, d) => ({ total: acc.total + d.total, done: acc.done + d.done, reviews: acc.reviews + (d.review ? 1 : 0) }),
    { total: 0, done: 0, reviews: 0 }
  );

  return (
    <Modal title="Weekly summary 📊" onClose={onClose} wide>
      <div className="week-nav">
        <button className="icon-btn" onClick={() => setEnd(shiftDay(end, -7))} aria-label="Previous week">‹</button>
        <span>{prettyDay(shiftDay(end, -6))} – {prettyDay(end)}</span>
        <button className="icon-btn" onClick={() => setEnd(shiftDay(end, 7))} disabled={end >= today} aria-label="Next week">›</button>
      </div>
      {!week ? <p>Loading…</p> : (
        <>
          <div className="week-stats">
            <div><strong>{totals.done}/{totals.total}</strong><span>tasks done</span></div>
            <div><strong>{totals.total ? Math.round((totals.done / totals.total) * 100) : 0}%</strong><span>completion</span></div>
            <div><strong>{totals.reviews}/7</strong><span>days reviewed</span></div>
          </div>
          <div className="week-chart">
            {week.map((d) => {
              const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
              return (
                <button key={d.day} className="week-day" onClick={() => onPick(d.day)} title={`${d.done}/${d.total} done`}>
                  <span className="week-pct">{d.total ? `${pct}%` : "–"}</span>
                  <span className="week-bar"><span style={{ height: `${pct}%` }} /></span>
                  <span className={`week-label ${d.day === today ? "is-today" : ""}`}>{shortDay(d.day)}</span>
                  <span className="week-review">{d.review ? "🌙" : ""}</span>
                </button>
              );
            })}
          </div>
          <h3>What I said I'd do better</h3>
          {lessons.length === 0 ? (
            <p className="empty">No "do better" answers this week yet.</p>
          ) : (
            <ul className="lesson-list">
              {lessons.map((d) => (
                <li key={d.day}><span className="muted">{shortDay(d.day)}</span> {d.review.do_better}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

function BackupSection({ online }) {
  const [status, setStatus] = useState("");
  const fileInput = useRef(null);

  const backupNow = async () => {
    const res = await api("/backup", { method: "POST" });
    setStatus(`Saved to ${res.file}`);
  };

  const importFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const ok = confirm(
      `Replace ALL tasks, notes and reviews in this app with the ones in "${file.name}"?\n\n` +
      "Tip: download a copy of the current data first, just in case."
    );
    if (!ok) return;
    setStatus("Importing…");
    const res = await fetch("/api/import", { method: "POST", body: file });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`Import failed: ${body.detail}`);
      return;
    }
    const c = body.counts;
    alert(`Imported ${c.todos} tasks, ${c.notes} notes and ${c.reviews} reviews. The app will now reload.`);
    window.location.reload();
  };

  return (
    <div className="backup">
      <h3>Backup & export</h3>
      <p className="muted small">
        {online
          ? "Your data is stored in an online database. Download a copy now and then to keep your own backup."
          : <>A backup is also made automatically each day (last 14 kept) in the <code>backups</code> folder.</>}
      </p>
      <div className="backup-buttons">
        {!online && <button className="btn" onClick={backupNow}>💾 Back up now</button>}
        <a className="btn" href="/api/export/database">⬇️ Download database</a>
        <button className="btn" onClick={() => fileInput.current.click()}>⬆️ Import backup</button>
        <input ref={fileInput} type="file" accept=".db" hidden onChange={importFile} />
      </div>
      <div className="backup-buttons">
        <span className="muted small">Spreadsheet (CSV):</span>
        <a className="link-btn" href="/api/export/tasks.csv">Tasks</a>
        <a className="link-btn" href="/api/export/notes.csv">Notes</a>
        <a className="link-btn" href="/api/export/reviews.csv">Reviews</a>
      </div>
      {status && <p className="small good">{status}</p>}
    </div>
  );
}

function SettingsModal({ info, settings, onSave, onTest, onClose }) {
  const [form, setForm] = useState(settings);
  const [perm, setPerm] = useState("Notification" in window ? Notification.permission : "unsupported");

  const enableNotifications = async () => {
    if (!("Notification" in window)) return;
    setPerm(await Notification.requestPermission());
  };

  return (
    <Modal title="Settings ⚙️" onClose={onClose}>
      <p className="muted">Reminders pop up while this page is open in your browser.</p>
      {REMINDERS.map((r) => (
        <div key={r.kind} className="setting-row">
          <label>
            <span className="field-label">{r.kind[0].toUpperCase() + r.kind.slice(1)} reminder</span>
            <input
              type="time"
              value={form[r.setting] || ""}
              onChange={(e) => setForm({ ...form, [r.setting]: e.target.value })}
            />
          </label>
          <button className="link-btn" onClick={() => onTest(r.kind)}>Preview</button>
        </div>
      ))}
      <div className="setting-row">
        <span>
          Desktop notifications: <strong>{perm === "granted" ? "on" : perm === "denied" ? "blocked" : "off"}</strong>
        </span>
        {perm === "default" && <button className="btn" onClick={enableNotifications}>Turn on</button>}
      </div>
      <BackupSection online={info.online} />
      {info.login_required && (
        <div className="setting-row">
          <span>You're logged in.</span>
          <button
            className="btn"
            onClick={async () => {
              await api("/logout", { method: "POST" });
              window.location.reload();
            }}
          >
            Log out
          </button>
        </div>
      )}
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(form)}>Save</button>
      </div>
    </Modal>
  );
}

function HistoryModal({ onPick, onClose }) {
  const [days, setDays] = useState(null);
  useEffect(() => { api("/history").then(setDays); }, []);
  return (
    <Modal title="History 📅" onClose={onClose}>
      {!days ? <p>Loading…</p> : days.length === 0 ? <p className="empty">Nothing saved yet.</p> : (
        <ul className="history-list">
          {days.map((d) => {
            const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
            return (
              <li key={d.day}>
                <button className="history-item" onClick={() => onPick(d.day)}>
                  <span className="history-day">{prettyDay(d.day)}</span>
                  <span className="history-stats">
                    {d.done}/{d.total} tasks · {d.notes} notes {d.reviewed ? "· reviewed ✓" : ""}
                  </span>
                  <span className="history-bar"><span style={{ width: `${pct}%` }} /></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

// ---------- App ----------

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { method: "POST", body: { password } });
      onLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1>My Day</h1>
        <p className="muted">Enter your password to open your to-do list.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy || !password}>
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

function Root() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/info").then(setInfo).catch(() => setError("Can't reach the app. It may be waking up — try refreshing in a minute."));
  }, []);

  if (error) return <div className="login-page"><p className="muted">{error}</p></div>;
  if (!info) return <div className="login-page"><p className="muted">Loading…</p></div>;
  if (info.login_required && !info.logged_in) {
    return <LoginScreen onLogin={() => setInfo({ ...info, logged_in: true })} />;
  }
  return <App info={info} />;
}

function App({ info }) {
  const [today, setToday] = useState(todayString());
  const [day, setDay] = useState(todayString());
  const [todos, setTodos] = useState([]);
  const [notes, setNotes] = useState([]);
  const [settings, setSettings] = useState(null);
  const [seen, setSeen] = useState(null); // reminder kinds already shown today
  const [prevReview, setPrevReview] = useState(undefined); // undefined = still loading
  const [modal, setModal] = useState(null);
  const [streak, setStreak] = useState(null);

  const isToday = day === today;

  const loadStreak = useCallback(() => {
    api(`/streak?day=${today}`).then(setStreak);
  }, [today]);

  const loadDay = useCallback(async (d) => {
    const [t, n] = await Promise.all([api(`/todos?day=${d}`), api(`/notes?day=${d}`)]);
    setTodos(t);
    setNotes(n);
  }, []);

  useEffect(() => { loadDay(day); }, [day, loadDay]);

  // Load settings, today's shown reminders and yesterday's "do better"
  useEffect(() => {
    api("/settings").then(setSettings);
    api(`/reminders/${today}`).then(setSeen);
    api(`/reviews/previous?day=${today}`).then(setPrevReview);
    loadStreak();
  }, [today, loadStreak]);

  const markSeen = useCallback((kind) => {
    setSeen((s) => (s && s.includes(kind) ? s : [...(s || []), kind]));
    return api(`/reminders/${today}/${kind}`, { method: "POST" });
  }, [today]);

  // Show the "do better" popup once per day when the app opens
  useEffect(() => {
    if (seen && prevReview && !seen.includes("yesterday") && !modal) {
      setModal("yesterday");
    }
  }, [seen, prevReview, modal]);

  // Check reminders every 20 seconds
  useEffect(() => {
    const check = () => {
      const nowDay = todayString();
      if (nowDay !== today) {
        // Midnight passed: move to the new day
        setToday(nowDay);
        setDay(nowDay);
        return;
      }
      if (!settings || !seen || modal || prevReview === undefined) return;
      // Yesterday's "do better" popup goes first
      if (prevReview && !seen.includes("yesterday")) return;
      const time = currentTime();
      const due = REMINDERS.filter((r) => settings[r.setting] && time >= settings[r.setting]);
      const latest = due[due.length - 1];
      if (!latest || seen.includes(latest.kind)) return;
      // Skip earlier reminders that were missed, just show the latest one
      due.forEach((r) => r !== latest && !seen.includes(r.kind) && markSeen(r.kind));
      setDay(nowDay);
      notify(latest.title, latest.body);
      setModal(latest.kind);
    };
    check();
    const timer = setInterval(check, 20000);
    return () => clearInterval(timer);
  }, [today, settings, seen, modal, prevReview, markSeen]);

  const closeModal = () => {
    if (["morning", "afternoon", "night", "yesterday"].includes(modal)) markSeen(modal);
    setModal(null);
  };

  // --- Todo actions ---
  const addTodo = async (text, targetDay = day) => {
    const todo = await api("/todos", { method: "POST", body: { day: targetDay, text } });
    if (targetDay === day) setTodos((t) => [...t, todo]);
  };
  const toggleTodo = async (todo) => {
    const updated = await api(`/todos/${todo.id}`, { method: "PATCH", body: { done: !todo.done } });
    setTodos((ts) => ts.map((t) => (t.id === todo.id ? updated : t)));
  };
  const togglePriority = async (todo) => {
    try {
      const updated = await api(`/todos/${todo.id}`, { method: "PATCH", body: { priority: !todo.priority } });
      setTodos((ts) => ts.map((t) => (t.id === todo.id ? updated : t)));
    } catch (e) {
      alert(e.message);
    }
  };
  const editTodo = async (todo, text) => {
    const updated = await api(`/todos/${todo.id}`, { method: "PATCH", body: { text } });
    setTodos((ts) => ts.map((t) => (t.id === todo.id ? updated : t)));
  };
  const deleteTodo = async (todo) => {
    await api(`/todos/${todo.id}`, { method: "DELETE" });
    setTodos((ts) => ts.filter((t) => t.id !== todo.id));
  };
  const reorderTodos = (list) =>
    api("/todos/reorder", { method: "PUT", body: { ids: list.map((t) => t.id) } });
  const carryOver = async () => {
    const res = await api("/todos/carry-over", {
      method: "POST", body: { from_day: shiftDay(today, -1), to_day: today },
    });
    await loadDay(day);
    if (!res.added) alert("No unfinished tasks from yesterday.");
  };

  // --- Note actions ---
  const addNote = async (text) => {
    const note = await api("/notes", { method: "POST", body: { day, text, is_html: true } });
    setNotes((n) => [note, ...n]);
  };
  const deleteNote = async (note) => {
    await api(`/notes/${note.id}`, { method: "DELETE" });
    setNotes((ns) => ns.filter((n) => n.id !== note.id));
  };

  const saveSettings = async (form) => {
    setSettings(await api("/settings", { method: "PUT", body: form }));
    setModal(null);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>My Day</h1>
          <div className="day-nav">
            <button className="icon-btn" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">‹</button>
            <span className="day-label">{isToday ? "Today · " : ""}{prettyDay(day)}</span>
            <button className="icon-btn" onClick={() => setDay(shiftDay(day, 1))} aria-label="Next day">›</button>
            {!isToday && <button className="link-btn" onClick={() => setDay(today)}>Back to today</button>}
          </div>
        </div>
        <nav className="header-actions">
          {streak && (
            <span
              className={`streak ${streak.current ? "" : "cold"}`}
              title={`Days in a row with a night review. Best: ${streak.best}`}
            >
              🔥 {streak.current} day{streak.current === 1 ? "" : "s"}
              {streak.current > 0 && !streak.reviewed_today && <small> · review tonight to keep it</small>}
            </span>
          )}
          <button className="btn" onClick={() => setModal("morning")}>☀️ Plan</button>
          <button className="btn" onClick={() => setModal("night")}>🌙 Review</button>
          <button className="btn" onClick={() => setModal("week")}>📊 Week</button>
          <button className="btn" onClick={() => setModal("history")}>📅 History</button>
          <button className="btn" onClick={() => setModal("settings")}>⚙️</button>
        </nav>
      </header>

      {isToday && prevReview && (
        <div className="callout">
          <strong>Today, do better at:</strong> {prevReview.do_better}
        </div>
      )}

      <section className="card">
        <ProgressBar todos={todos} />
      </section>

      <main className="columns">
        <section className="card">
          <h2>To-do list</h2>
          <AddTodoForm onAdd={addTodo} />
          <TodoList
            todos={todos}
            setTodos={setTodos}
            onToggle={toggleTodo}
            onPriority={togglePriority}
            onDelete={deleteTodo}
            onEdit={editTodo}
            onReorder={reorderTodos}
          />
          <p className="hint">☆ star your top 3 · drag ⋮⋮ or use ↑ ↓ to reorder · double-click a task to edit it</p>
        </section>
        <section className="card">
          <h2>Quick notes</h2>
          <Notes notes={notes} onAdd={addNote} onDelete={deleteNote} />
        </section>
      </main>

      {modal === "yesterday" && prevReview && <YesterdayPopup review={prevReview} onClose={closeModal} />}
      {modal === "morning" && (
        <MorningModal
          todos={todos}
          prevReview={prevReview}
          onAdd={addTodo}
          onPriority={togglePriority}
          onCarryOver={carryOver}
          onClose={closeModal}
        />
      )}
      {modal === "afternoon" && <AfternoonModal todos={todos} onToggle={toggleTodo} onClose={closeModal} />}
      {modal === "night" && <ReviewModal day={day} todos={todos} onClose={() => {
        closeModal();
        api(`/reviews/previous?day=${today}`).then(setPrevReview);
        loadStreak();
      }} />}
      {modal === "week" && (
        <WeekModal today={today} onPick={(d) => { setDay(d); setModal(null); }} onClose={() => setModal(null)} />
      )}
      {modal === "settings" && settings && (
        <SettingsModal
          info={info}
          settings={settings}
          onSave={saveSettings}
          onTest={(kind) => setModal(kind)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "history" && (
        <HistoryModal onPick={(d) => { setDay(d); setModal(null); }} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
