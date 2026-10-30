/**
 * Контроль контрагентов — клиентская логика
 * Vanilla JS + Supabase
 */

(function () {
  'use strict';

  // ========== Конфигурация ==========
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT') ||
      !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('YOUR_ANON')) {
    document.body.innerHTML = `
      <div style="padding:40px;text-align:center;color:#f1f5f9;background:#0f172a;min-height:100vh;font-family:sans-serif;">
        <h1>Настройка не завершена</h1>
        <p style="margin-top:16px;color:#94a3b8;max-width:500px;margin-left:auto;margin-right:auto;">
          Откройте файл <code>index.html</code> и замените значения<br>
          <strong>SUPABASE_URL</strong> и <strong>SUPABASE_ANON_KEY</strong><br>
          на данные вашего проекта Supabase.
        </p>
      </div>`;
    return;
  }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  // ========== Состояние ==========
  let currentUser = null;
  let counterparties = [];
  let isLoading = false;
  let currentFilter = 'all';
  let currentSort = 'name-asc';
  let searchQuery = '';
  let pendingAction = null; // для подтверждений
  let isSubmitting = false;

  // ========== DOM ==========
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loginScreen = $('#login-screen');
  const appScreen = $('#app-screen');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');
  const loginLoading = $('#login-loading');
  const loginBtn = $('#login-btn');
  const currentUserEmail = $('#current-user-email');
  const counterpartiesList = $('#counterparties-list');
  const emptyState = $('#empty-state');
  const loadingState = $('#loading-state');
  const searchInput = $('#search-input');
  const filterStatus = $('#filter-status');
  const sortBy = $('#sort-by');
  const addBtn = $('#add-btn');
  const historyBtn = $('#history-btn');
  const logoutBtn = $('#logout-btn');

  // Модалки
  const modalOverlay = $('#modal-overlay');
  const modalTitle = $('#modal-title');
  const modalForm = $('#modal-form');
  const counterpartyNameInput = $('#counterparty-name');
  const modalError = $('#modal-error');
  const modalCancel = $('#modal-cancel');
  const modalSubmit = $('#modal-submit');

  const confirmOverlay = $('#confirm-overlay');
  const confirmTitle = $('#confirm-title');
  const confirmMessage = $('#confirm-message');
  const confirmCancel = $('#confirm-cancel');
  const confirmOk = $('#confirm-ok');

  const historyOverlay = $('#history-overlay');
  const historyList = $('#history-list');
  const historyEmpty = $('#history-empty');
  const historyLoading = $('#history-loading');
  const historyClose = $('#history-close');

  const toastEl = $('#toast');

  // ========== Утилиты ==========
  function showToast(message, type = 'info') {
    toastEl.textContent = message;
    toastEl.className = `toast ${type}`;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 3500);
  }

  function formatDateBishkek(isoString) {
    try {
      const date = new Date(isoString);
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Asia/Bishkek',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return isoString;
    }
  }

  function statusLabel(isAllowed) {
    return isAllowed ? 'ЗАКУП РАЗРЕШЁН' : 'ЗАКУП ЗАПРЕЩЁН';
  }

  function statusEmoji(isAllowed) {
    return isAllowed ? '🟢' : '🔴';
  }

  // ========== Авторизация ==========
  async function checkSession() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.error('Session error:', error);
      showLogin();
      return;
    }
    if (session?.user) {
      currentUser = session.user;
      showApp();
      await loadCounterparties();
      subscribeRealtime();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
    currentUser = null;
  }

  function showApp() {
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    currentUserEmail.textContent = currentUser?.email || '';
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;

    loginError.classList.add('hidden');
    loginLoading.classList.remove('hidden');
    loginBtn.disabled = true;

    const email = $('#email').value.trim();
    const password = $('#password').value;

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      currentUser = data.user;
      showApp();
      await loadCounterparties();
      subscribeRealtime();
      showToast('Вход выполнен', 'success');
    } catch (err) {
      loginError.textContent = err.message === 'Invalid login credentials'
        ? 'Неверный email или пароль'
        : (err.message || 'Ошибка входа');
      loginError.classList.remove('hidden');
    } finally {
      loginLoading.classList.add('hidden');
      loginBtn.disabled = false;
      isSubmitting = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    unsubscribeRealtime();
    counterparties = [];
    showLogin();
    showToast('Вы вышли из системы');
  });

  // Слушаем изменение сессии (истечение и т.д.)
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      currentUser = null;
      unsubscribeRealtime();
      showLogin();
    } else if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
      currentUser = session.user;
    }
  });

  // ========== Загрузка данных ==========
  async function loadCounterparties() {
    if (!currentUser) return;
    isLoading = true;
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    counterpartiesList.innerHTML = '';

    try {
      const { data, error } = await supabase
        .from('counterparties')
        .select('*')
        .is('archived_at', null)
        .order('name', { ascending: true });

      if (error) throw error;

      counterparties = data || [];
      renderList();
    } catch (err) {
      console.error(err);
      showToast('Ошибка загрузки данных. Проверьте интернет.', 'error');
      emptyState.classList.remove('hidden');
      emptyState.querySelector('p').textContent = 'Не удалось загрузить данные';
    } finally {
      isLoading = false;
      loadingState.classList.add('hidden');
    }
  }

  // ========== Отрисовка списка ==========
  function getFilteredSorted() {
    let list = [...counterparties];

    // Поиск
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q));
    }

    // Фильтр
    if (currentFilter === 'allowed') {
      list = list.filter(c => c.is_allowed);
    } else if (currentFilter === 'forbidden') {
      list = list.filter(c => !c.is_allowed);
    }

    // Сортировка
    list.sort((a, b) => {
      if (currentSort === 'name-asc') {
        return a.name.localeCompare(b.name, 'ru');
      }
      if (currentSort === 'name-desc') {
        return b.name.localeCompare(a.name, 'ru');
      }
      if (currentSort === 'updated-desc') {
        return new Date(b.updated_at) - new Date(a.updated_at);
      }
      return 0;
    });

    return list;
  }

  function renderList() {
    const list = getFilteredSorted();
    counterpartiesList.innerHTML = '';

    if (list.length === 0) {
      emptyState.classList.remove('hidden');
      if (searchQuery || currentFilter !== 'all') {
        emptyState.querySelector('p').textContent = 'Ничего не найдено';
        emptyState.querySelector('.hint').textContent = 'Попробуйте изменить поиск или фильтр';
      } else {
        emptyState.querySelector('p').textContent = 'Нет контрагентов';
        emptyState.querySelector('.hint').textContent = 'Нажмите «+ Добавить контрагента», чтобы создать первого';
      }
      return;
    }

    emptyState.classList.add('hidden');

    list.forEach(c => {
      const card = document.createElement('div');
      card.className = `card ${c.is_allowed ? 'allowed' : 'forbidden'}`;
      card.dataset.id = c.id;

      card.innerHTML = `
        <div class="card-header">
          <div class="card-name">${escapeHtml(c.name)}</div>
          <div class="status-badge ${c.is_allowed ? 'allowed' : 'forbidden'}">
            ${statusEmoji(c.is_allowed)} ${statusLabel(c.is_allowed)}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn ${c.is_allowed ? 'btn-danger' : 'btn-primary'} toggle-status-btn" data-id="${c.id}">
            ${c.is_allowed ? 'Запретить закуп' : 'Разрешить закуп'}
          </button>
          <button class="btn btn-secondary rename-btn" data-id="${c.id}">Переименовать</button>
          <button class="btn btn-ghost archive-btn" data-id="${c.id}">Архивировать</button>
        </div>
      `;

      counterpartiesList.appendChild(card);
    });

    // Навешиваем обработчики
    $$('.toggle-status-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const item = counterparties.find(c => c.id === id);
        if (!item) return;
        openStatusConfirm(item);
      });
    });

    $$('.rename-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const item = counterparties.find(c => c.id === id);
        if (!item) return;
        openRenameModal(item);
      });
    });

    $$('.archive-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const item = counterparties.find(c => c.id === id);
        if (!item) return;
        openArchiveConfirm(item);
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ========== Поиск / фильтр / сортировка ==========
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    renderList();
  });

  filterStatus.addEventListener('change', () => {
    currentFilter = filterStatus.value;
    renderList();
  });

  sortBy.addEventListener('change', () => {
    currentSort = sortBy.value;
    renderList();
  });

  // ========== Добавление контрагента ==========
  addBtn.addEventListener('click', () => {
    openAddModal();
  });

  function openAddModal() {
    modalTitle.textContent = 'Добавить контрагента';
    counterpartyNameInput.value = '';
    modalError.classList.add('hidden');
    modalSubmit.textContent = 'Сохранить';
    modalOverlay.dataset.mode = 'add';
    modalOverlay.classList.remove('hidden');
    setTimeout(() => counterpartyNameInput.focus(), 100);
  }

  function openRenameModal(item) {
    modalTitle.textContent = 'Переименовать контрагента';
    counterpartyNameInput.value = item.name;
    modalError.classList.add('hidden');
    modalSubmit.textContent = 'Сохранить';
    modalOverlay.dataset.mode = 'rename';
    modalOverlay.dataset.id = item.id;
    modalOverlay.classList.remove('hidden');
    setTimeout(() => {
      counterpartyNameInput.focus();
      counterpartyNameInput.select();
    }, 100);
  }

  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  function closeModal() {
    modalOverlay.classList.add('hidden');
    isSubmitting = false;
  }

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    modalSubmit.disabled = true;
    modalError.classList.add('hidden');

    const name = counterpartyNameInput.value.trim();
    if (!name) {
      modalError.textContent = 'Название не может быть пустым';
      modalError.classList.remove('hidden');
      isSubmitting = false;
      modalSubmit.disabled = false;
      return;
    }

    try {
      if (modalOverlay.dataset.mode === 'add') {
        // Проверка похожих названий на клиенте (дополнительно к серверу)
        const similar = counterparties.find(c =>
          c.name.toLowerCase() === name.toLowerCase()
        );
        if (similar) {
          modalError.textContent = `Контрагент «${similar.name}» уже существует. Проверьте список.`;
          modalError.classList.remove('hidden');
          isSubmitting = false;
          modalSubmit.disabled = false;
          return;
        }

        const { data, error } = await supabase.rpc('create_counterparty', { p_name: name });
        if (error) throw error;

        // Realtime обновит список, но на всякий случай добавим локально
        if (data && !counterparties.find(c => c.id === data.id)) {
          counterparties.push(data);
          renderList();
        }
        showToast('Контрагент добавлен', 'success');
        closeModal();
      } else {
        // rename
        const id = modalOverlay.dataset.id;
        const { data, error } = await supabase.rpc('rename_counterparty', {
          p_id: id,
          p_new_name: name
        });
        if (error) throw error;

        const idx = counterparties.findIndex(c => c.id === id);
        if (idx !== -1 && data) {
          counterparties[idx] = data;
          renderList();
        }
        showToast('Название изменено', 'success');
        closeModal();
      }
    } catch (err) {
      console.error(err);
      let msg = err.message || 'Ошибка сохранения';
      if (msg.includes('уже существует')) {
        msg = 'Контрагент с похожим названием уже существует';
      }
      modalError.textContent = msg;
      modalError.classList.remove('hidden');
    } finally {
      isSubmitting = false;
      modalSubmit.disabled = false;
    }
  });

  // ========== Смена статуса ==========
  function openStatusConfirm(item) {
    pendingAction = { type: 'status', item };
    if (item.is_allowed) {
      confirmTitle.textContent = 'Запретить закуп?';
      confirmMessage.textContent = `Вы хотите ЗАПРЕТИТЬ закуп контрагента «${item.name}»?`;
      confirmOk.textContent = 'Да, запретить';
      confirmOk.className = 'btn btn-danger';
    } else {
      confirmTitle.textContent = 'Разрешить закуп?';
      confirmMessage.textContent = `Вы хотите РАЗРЕШИТЬ закуп контрагента «${item.name}»?`;
      confirmOk.textContent = 'Да, разрешить';
      confirmOk.className = 'btn btn-primary';
    }
    confirmOverlay.classList.remove('hidden');
  }

  function openArchiveConfirm(item) {
    pendingAction = { type: 'archive', item };
    confirmTitle.textContent = 'Архивировать контрагента?';
    confirmMessage.textContent = `Вы действительно хотите архивировать «${item.name}»? Это действие может повлиять на дальнейшую работу с его записью. История действий сохранится.`;
    confirmOk.textContent = 'Да, архивировать';
    confirmOk.className = 'btn btn-danger';
    confirmOverlay.classList.remove('hidden');
  }

  confirmCancel.addEventListener('click', () => {
    confirmOverlay.classList.add('hidden');
    pendingAction = null;
  });

  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) {
      confirmOverlay.classList.add('hidden');
      pendingAction = null;
    }
  });

  confirmOk.addEventListener('click', async () => {
    if (!pendingAction || isSubmitting) return;
    isSubmitting = true;
    confirmOk.disabled = true;

    const { type, item } = pendingAction;

    try {
      if (type === 'status') {
        const newAllowed = !item.is_allowed;
        const { data, error } = await supabase.rpc('change_counterparty_status', {
          p_id: item.id,
          p_new_allowed: newAllowed
        });
        if (error) throw error;

        // Обновляем локально (Realtime тоже придёт)
        const idx = counterparties.findIndex(c => c.id === item.id);
        if (idx !== -1 && data) {
          counterparties[idx] = data;
          renderList();
        }
        showToast(newAllowed ? 'Закуп разрешён' : 'Закуп запрещён', 'success');
      } else if (type === 'archive') {
        const { error } = await supabase.rpc('archive_counterparty', { p_id: item.id });
        if (error) throw error;

        counterparties = counterparties.filter(c => c.id !== item.id);
        renderList();
        showToast('Контрагент архивирован', 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Ошибка операции. Статус не изменён.', 'error');
      // Перезагружаем актуальные данные
      await loadCounterparties();
    } finally {
      isSubmitting = false;
      confirmOk.disabled = false;
      confirmOverlay.classList.add('hidden');
      pendingAction = null;
    }
  });

  // ========== История ==========
  historyBtn.addEventListener('click', openHistory);
  historyClose.addEventListener('click', () => historyOverlay.classList.add('hidden'));
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) historyOverlay.classList.add('hidden');
  });

  async function openHistory() {
    historyOverlay.classList.remove('hidden');
    historyList.innerHTML = '';
    historyEmpty.classList.add('hidden');
    historyLoading.classList.remove('hidden');

    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;

      historyLoading.classList.add('hidden');

      if (!data || data.length === 0) {
        historyEmpty.classList.remove('hidden');
        return;
      }

      data.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'history-item';

        let actionText = '';
        switch (entry.action) {
          case 'created':
            actionText = `создал контрагента «${entry.counterparty_name}» (закуп разрешён)`;
            break;
          case 'status_changed':
            const from = entry.old_status ? 'Разрешён' : 'Запрещён';
            const to = entry.new_status ? 'Разрешён' : 'Запрещён';
            actionText = `изменил статус «${entry.counterparty_name}»: ${from} → ${to}`;
            break;
          case 'renamed':
            actionText = `переименовал «${entry.old_name}» → «${entry.new_name}»`;
            break;
          case 'archived':
            actionText = `архивировал «${entry.counterparty_name}»`;
            break;
          default:
            actionText = `${entry.action} — ${entry.counterparty_name}`;
        }

        item.innerHTML = `
          <div class="history-time">${formatDateBishkek(entry.created_at)}</div>
          <div class="history-action">
            <strong>${escapeHtml(entry.actor_email)}</strong> — ${escapeHtml(actionText)}
          </div>
        `;
        historyList.appendChild(item);
      });
    } catch (err) {
      console.error(err);
      historyLoading.classList.add('hidden');
      historyEmpty.classList.remove('hidden');
      historyEmpty.querySelector('p').textContent = 'Не удалось загрузить историю';
    }
  }

  // ========== Realtime ==========
  let realtimeChannel = null;

  function subscribeRealtime() {
    if (realtimeChannel) return;

    realtimeChannel = supabase
      .channel('counterparties-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'counterparties' },
        (payload) => {
          handleRealtimeChange(payload);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'audit_log' },
        () => {
          // Можно обновить историю, если она открыта
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime подключён');
        }
      });
  }

  function unsubscribeRealtime() {
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  function handleRealtimeChange(payload) {
    const { eventType, new: newRow, old: oldRow } = payload;

    if (eventType === 'INSERT') {
      if (newRow.archived_at) return; // не показываем архивные
      if (!counterparties.find(c => c.id === newRow.id)) {
        counterparties.push(newRow);
        renderList();
      }
    } else if (eventType === 'UPDATE') {
      if (newRow.archived_at) {
        // Архивирован — убираем из списка
        counterparties = counterparties.filter(c => c.id !== newRow.id);
        renderList();
      } else {
        const idx = counterparties.findIndex(c => c.id === newRow.id);
        if (idx !== -1) {
          counterparties[idx] = newRow;
        } else {
          counterparties.push(newRow);
        }
        renderList();
      }
    } else if (eventType === 'DELETE') {
      counterparties = counterparties.filter(c => c.id !== oldRow.id);
      renderList();
    }
  }

  // ========== Обработка офлайна ==========
  window.addEventListener('online', () => {
    showToast('Соединение восстановлено', 'success');
    if (currentUser) loadCounterparties();
  });

  window.addEventListener('offline', () => {
    showToast('Нет соединения с интернетом', 'error');
  });

  // ========== Старт ==========
  checkSession();
})();
