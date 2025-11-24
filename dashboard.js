// Indicação de carregamento do script para debug
try {
    console.debug('[dashboard] script loaded');
} catch (e) { /* ignore */ }

// Captura erros globais para evitar que silenciem execuções posteriores
window.addEventListener('error', (ev) => {
    try { console.error('[dashboard] window.onerror', ev.message, ev.error || ev); } catch(e){}
});
window.addEventListener('unhandledrejection', (ev) => {
    try { console.error('[dashboard] unhandledrejection', ev.reason); } catch(e){}
});

document.addEventListener('DOMContentLoaded', () => {
    // Variável global para o ticket selecionado
    let currentTicketId = null;
    // Variável global para armazenar informações do agente e departamento do ticket ativo
    let currentTicketAgentInfo = null;
    // Variável global para o usuário logado
    let currentUser = null;
    // Variável global para o token de sessão
    let sessionToken = null;
    // Intervalo para atualizar usuários online
    let onlineUsersInterval = null;
    // Intervalo para atualizar contadores de não lidas no chat interno
    let unreadCountsInterval = null;
    // Intervalo para heartbeat
    let heartbeatInterval = null;
    
    // Carrega o usuário logado do localStorage
    try {
        const currentUserStr = localStorage.getItem('currentUser');
        currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
        sessionToken = localStorage.getItem('sessionToken');
        if (!currentUser) {
            // Se não houver usuário logado, redireciona para login
            window.location.href = '/';
            return;
        }
    } catch (error) {
        console.error('Erro ao carregar usuário:', error);
        window.location.href = '/';
        return;
    }
    
    // Carrega e aplica permissões do usuário
    (async function initializePermissions() {
        try {
            console.log('🔐 Iniciando carregamento de permissões...');
            const permissionsData = await permissionsManager.loadUserPermissions();
            
            if (permissionsData) {
                console.log('✅ Permissões carregadas:', {
                    profile: permissionsData.profile,
                    permissions: permissionsData.permissions
                });
                
                // Aplica permissões na UI
                permissionsManager.applyUIPermissions();
                console.log('✅ Permissões aplicadas na interface');
            } else {
                console.warn('⚠️ Não foi possível carregar permissões do usuário');
            }
        } catch (error) {
            console.error('❌ Erro ao inicializar permissões:', error);
        }
    })();
    
    // Alias para localStorage usado por várias funções
    const ls = window.localStorage;

    // Função simples de notificação (substitui alert()).
    // type: 'success' | 'danger' | 'warning' | 'info'
    function showNotification(message, type = 'info', timeout = 3500) {
        try {
            let container = document.getElementById('app-notifications');
            if (!container) {
                container = document.createElement('div');
                container.id = 'app-notifications';
                container.style.position = 'fixed';
                container.style.right = '16px';
                container.style.top = '16px';
                container.style.zIndex = 1080;
                document.body.appendChild(container);
            }

            const colors = {
                success: '#198754',
                danger: '#dc3545',
                warning: '#ffc107',
                info: '#0d6efd'
            };

            const bg = colors[type] || colors.info;
            const notif = document.createElement('div');
            notif.className = 'app-notif';
            notif.style.background = '#fff';
            notif.style.border = `1px solid ${bg}`;
            notif.style.padding = '10px 14px';
            notif.style.marginTop = '8px';
            notif.style.borderRadius = '6px';
            notif.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
            notif.style.minWidth = '240px';
            notif.style.fontFamily = 'Helvetica, Arial, sans-serif';
            notif.style.fontSize = '14px';

            const icon = document.createElement('span');
            icon.style.display = 'inline-block';
            icon.style.width = '18px';
            icon.style.marginRight = '8px';
            icon.style.verticalAlign = 'middle';
            icon.textContent = type === 'success' ? '✅' : (type === 'danger' ? '❌' : (type === 'warning' ? '⚠️' : 'ℹ️'));

            const text = document.createElement('span');
            text.style.verticalAlign = 'middle';
            text.textContent = message;

            notif.appendChild(icon);
            notif.appendChild(text);

            container.appendChild(notif);

            // Remove depois do timeout com fade
            setTimeout(() => {
                try {
                    notif.style.transition = 'opacity 300ms ease, transform 300ms ease';
                    notif.style.opacity = '0';
                    notif.style.transform = 'translateX(10px)';
                    setTimeout(() => { if (notif && notif.parentNode) notif.parentNode.removeChild(notif); }, 350);
                } catch (e) { /* ignore */ }
            }, timeout);
        } catch (e) {
            // fallback para alert caso algo falhe
            try { alert(message); } catch (e2) { console.log(message); }
        }
    }

    // Função de confirmação que usa modal Bootstrap e retorna uma Promise<boolean>
    function showConfirm(message, title = 'Confirmação') {
        return new Promise((resolve) => {
            try {
                let modalEl = document.getElementById('app-confirm-modal');
                if (!modalEl) {
                    // Cria modal se não existir (fallback programático)
                    modalEl = document.createElement('div');
                    modalEl.id = 'app-confirm-modal';
                    modalEl.className = 'modal fade';
                    modalEl.tabIndex = -1;
                    modalEl.innerHTML = `
                        <div class="modal-dialog modal-sm modal-dialog-centered">
                          <div class="modal-content">
                            <div class="modal-header">
                              <h5 class="modal-title">${title}</h5>
                              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                            </div>
                            <div class="modal-body">
                              <p id="app-confirm-modal-message">${message}</p>
                            </div>
                            <div class="modal-footer">
                              <button type="button" class="btn btn-secondary" id="app-confirm-cancel">Cancelar</button>
                              <button type="button" class="btn btn-primary" id="app-confirm-ok">OK</button>
                            </div>
                          </div>
                        </div>`;
                    document.body.appendChild(modalEl);
                }

                // Atualiza conteúdo e título
                const msgEl = modalEl.querySelector('#app-confirm-modal-message');
                if (msgEl) msgEl.textContent = message;
                const titleEl = modalEl.querySelector('.modal-title');
                if (titleEl) titleEl.textContent = title;

                const bsModal = new bootstrap.Modal(modalEl, { backdrop: 'static' });
                const okBtn = modalEl.querySelector('#app-confirm-ok');
                const cancelBtn = modalEl.querySelector('#app-confirm-cancel');

                let resolved = false;

                const onHidden = () => {
                    if (resolved) return;
                    resolved = true;
                    resolve(false);
                };

                const onOk = () => {
                    if (resolved) return;
                    resolved = true;
                    try { bsModal.hide(); } catch (e) { /* ignore */ }
                    resolve(true);
                };

                const onCancel = () => {
                    if (resolved) return;
                    resolved = true;
                    try { bsModal.hide(); } catch (e) { /* ignore */ }
                    resolve(false);
                };

                if (okBtn) okBtn.addEventListener('click', onOk);
                if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
                modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });

                // Ao esconder, removemos os listeners (limpeza)
                modalEl.addEventListener('hidden.bs.modal', () => {
                    if (okBtn) okBtn.removeEventListener('click', onOk);
                    if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
                }, { once: true });

                bsModal.show();
            } catch (e) {
                // fallback para confirm() nativo
                try { resolve(window.confirm(message)); } catch (e2) { resolve(false); }
            }
        });
    }
    
    // Elementos da UI
    const painelContent = document.getElementById('painel-content');
    const conexoesContent = document.getElementById('conexoes-content');
    const ingressosContent = document.getElementById('ingressos-content');
    const filasContent = document.getElementById('filas-content');
    const usuariosContent = document.getElementById('usuarios-content');
    const contatosContent = document.getElementById('contatos-content');
    const respostasRapidasContent = document.getElementById('respostas-rapidas-content');
    const chatInternoContent = document.getElementById('chat-interno-content');
    const menuPainel = document.getElementById('menu-painel');
    const menuConexoes = document.getElementById('menu-conexoes');
    const menuIngressos = document.getElementById('menu-ingressos');
    const menuFilas = document.getElementById('menu-filas');
    const menuUsuarios = document.getElementById('menu-usuarios');
    const menuContatos = document.getElementById('menu-contatos');
    const menuRespostasRapidas = document.getElementById('menu-respostas-rapidas');
    const menuChatInterno = document.getElementById('menu-chat-interno');
    const menuWhatsappSettingsItem = document.getElementById('menu-whatsapp-settings-item');
    const mainTitle = document.getElementById('main-title');
    const mainContentArea = document.getElementById('main-content-area');
    const mainHeader = document.getElementById('main-header');
    const logoutButton = document.getElementById('logout-button');
    const atendimentoCountEl = document.getElementById('atendimento-count');
    const aguardandoCountEl = document.getElementById('aguardando-count');
    const finalizadoCountEl = document.getElementById('finalizado-count');
    // Filtros do Painel
    const filterDateStartInput = document.getElementById('filter-date-start');
    const filterDateEndInput = document.getElementById('filter-date-end');
    const filterUserSelect = document.getElementById('filter-user');
    // Controle de concorrência para evitar popular o filtro em paralelo e gerar duplicatas
    let dashboardUsersFilterReqId = 0;
    const applyFiltersButton = document.getElementById('apply-filters-button');
    const clearFiltersButton = document.getElementById('clear-filters-button');
    const exportPdfButton = document.getElementById('export-pdf-button');
    const connectionsTableBody = document.querySelector('#conexoes-content tbody');
    const ticketListContainer = document.getElementById('ticket-list');
    const noTicketsMessage = document.getElementById('no-tickets-message');
    const notificationAguardando = document.getElementById('notification-aguardando');
    const tabAguardando = document.getElementById('tab-aguardando');
    const tabAtendendo = document.getElementById('tab-atendendo');
    // Notificações (ícone no cabeçalho)
    const notificationsBadge = document.getElementById('notifications-badge');
    const notificationsList = document.getElementById('notifications-list');
    // contador persistido de notificações não lidas
    let notificationsCount = Number(localStorage.getItem('appNotificationsCount') || 0) || 0;
    // Filtro de filas selecionadas pelo agente (array de ids). Se null -> usar currentUser.queue_ids (padrão)
    let selectedQueueFilters = null;

    function renderNotificationsBadge() {
        try {
            if (!notificationsBadge) return;
            if (notificationsCount > 0) {
                notificationsBadge.textContent = notificationsCount > 99 ? '99+' : String(notificationsCount);
                notificationsBadge.classList.remove('d-none');
            } else {
                notificationsBadge.classList.add('d-none');
            }
        } catch (e) { console.warn('Erro ao renderizar notifications badge', e); }
    }

    // Popula o dropdown de filtro de filas ao lado do botão "Filas"
    async function populateTicketQueueFilterList() {
        try {
            const container = document.getElementById('ticket-queue-filter-list');
            if (!container) return;
            container.innerHTML = '';

            const resp = await fetch('/api/queues');
            if (!resp.ok) return;
            const queues = await resp.json();

            // Determina quais filas este agente pode ver no filtro
            let visibleQueues = queues;
            const isPrivileged = currentUser && (String(currentUser.profile).toLowerCase() === 'admin' || String(currentUser.profile).toLowerCase() === 'supervisor');
            if (!isPrivileged) {
                // Usuários comuns só veem as filas que lhes foram atribuídas (currentUser.queue_ids)
                if (currentUser && Array.isArray(currentUser.queue_ids) && currentUser.queue_ids.length > 0) {
                    const allowed = currentUser.queue_ids.map(n => Number(n));
                    visibleQueues = queues.filter(q => allowed.indexOf(Number(q.id)) !== -1);
                } else {
                    visibleQueues = [];
                }
            }

            // Carrega filtros salvos (localStorage) — array de ids
            try {
                const saved = JSON.parse(localStorage.getItem('ticketQueueFilters') || 'null');
                if (Array.isArray(saved)) selectedQueueFilters = saved.map(v => Number(v));
            } catch (e) { /* ignore */ }

            // Se não houver seleção salva, pre-seleciona as filas do currentUser (mas apenas as visíveis)
            if (!selectedQueueFilters) {
                if (Array.isArray(visibleQueues) && visibleQueues.length > 0) {
                    selectedQueueFilters = visibleQueues.map(q => Number(q.id));
                } else if (currentUser && Array.isArray(currentUser.queue_ids) && currentUser.queue_ids.length > 0) {
                    // fallback: usa queue_ids do usuário intersectando com queues recebidas
                    const qids = currentUser.queue_ids.map(n => Number(n));
                    selectedQueueFilters = queues.filter(q => qids.indexOf(Number(q.id)) !== -1).map(q => Number(q.id));
                } else {
                    selectedQueueFilters = [];
                }
            }

            // Título com opção de limpar seleção
            const header = document.createElement('li');
            header.className = 'dropdown-header';
            header.textContent = 'Filtrar por Filas';
            container.appendChild(header);

            if (!visibleQueues || visibleQueues.length === 0) {
                const none = document.createElement('li');
                none.className = 'px-2 py-2 text-muted small';
                none.textContent = 'Nenhuma fila disponível para seu perfil.';
                container.appendChild(none);
            } else {
                visibleQueues.forEach(q => {
                    const li = document.createElement('li');
                    li.className = 'px-2 py-1';
                    const id = `ticket-filter-queue-${q.id}`;
                    const checked = Array.isArray(selectedQueueFilters) && selectedQueueFilters.indexOf(Number(q.id)) !== -1;
                    li.innerHTML = `
                        <div class="form-check ms-2">
                            <input class="form-check-input ticket-queue-filter-checkbox" type="checkbox" value="${q.id}" id="${id}" ${checked ? 'checked' : ''}>
                            <label class="form-check-label" for="${id}">${q.name}</label>
                        </div>`;
                    container.appendChild(li);
                });
            }

            // Ação footer: aplicar/limpar
            const divider = document.createElement('li');
            divider.innerHTML = '<hr class="dropdown-divider">';
            container.appendChild(divider);
            const actions = document.createElement('li');
            actions.className = 'px-2 py-2 d-flex justify-content-between';
            actions.innerHTML = `<button class="btn btn-sm btn-link" id="ticket-filter-clear">Limpar</button><button class="btn btn-sm btn-primary" id="ticket-filter-apply">Aplicar</button>`;
            container.appendChild(actions);

            // Listeners
            container.querySelectorAll('.ticket-queue-filter-checkbox').forEach(ch => {
                ch.addEventListener('change', () => {
                    // não dispara loadTickets imediatamente — espera Apply
                });
            });
            const btnClear = document.getElementById('ticket-filter-clear');
            const btnApply = document.getElementById('ticket-filter-apply');
            if (btnClear) btnClear.addEventListener('click', (e) => {
                e.preventDefault();
                selectedQueueFilters = [];
                // limpar checks
                container.querySelectorAll('.ticket-queue-filter-checkbox').forEach(ch => ch.checked = false);
                localStorage.removeItem('ticketQueueFilters');
                loadTickets();
            });
            if (btnApply) btnApply.addEventListener('click', (e) => {
                e.preventDefault();
                const picks = Array.from(container.querySelectorAll('.ticket-queue-filter-checkbox:checked')).map(i => Number(i.value));
                selectedQueueFilters = picks;
                try { localStorage.setItem('ticketQueueFilters', JSON.stringify(selectedQueueFilters)); } catch(e){}
                loadTickets();
            });

            // Atualiza label do botão para indicar quantas filas selecionadas
            updateQueueFilterButtonLabel();

        } catch (e) {
            console.warn('Falha ao popular filtro de filas:', e);
        }
    }

    // Mapa de cores das filas carregadas (id -> color)
    let queueColorMap = {};

    function updateQueueFilterButtonLabel() {
        try {
            const btn = document.querySelector('#ticket-queue-filter-list').closest('.dropdown').querySelector('button');
            if (!btn) return;
            if (Array.isArray(selectedQueueFilters) && selectedQueueFilters.length > 0) {
                btn.textContent = `Filas (${selectedQueueFilters.length})`;
            } else {
                btn.textContent = 'Filas';
            }
        } catch (e) { /* ignore */ }
    }

    function setNotificationsCount(n) {
        notificationsCount = Math.max(0, Number(n) || 0);
        try { localStorage.setItem('appNotificationsCount', String(notificationsCount)); } catch(e){}
        renderNotificationsBadge();
    }

    function addNotificationItem(data) {
        try {
            if (!notificationsList) return;
            const li = document.createElement('li');
            li.className = 'dropdown-item notification-item d-flex justify-content-between align-items-start';
            li.setAttribute('data-ticket-id', data.ticket_id);
            // Tenta pegar o nome do ticket já renderizado na lista lateral, se disponível
            let contactName = 'Novo contato';
            try {
                const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${data.ticket_id}']`);
                if (ticketEl) {
                    const h6 = ticketEl.querySelector('h6');
                    if (h6) contactName = h6.textContent.trim();
                }
            } catch (e) { /* ignore */ }

            const snippet = (data.body || '').slice(0, 80).replace(/\s+/g, ' ');
            li.innerHTML = `<div class="flex-grow-1"><strong class="d-block">${contactName}</strong><div class="small text-muted">${snippet}</div></div><small class="text-muted ms-2">${new Date(data.timestamp || Date.now()).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</small>`;
            // Insere no topo
            notificationsList.insertBefore(li, notificationsList.firstChild);
        } catch (e) { console.warn('Falha ao adicionar item de notificação', e); }
    }

    function clearNotificationsForTicket(ticketId) {
        try {
            if (!notificationsList) return;
            const items = Array.from(notificationsList.querySelectorAll('.notification-item'));
            let removed = 0;
            items.forEach(it => {
                if (it.getAttribute('data-ticket-id') === String(ticketId)) {
                    it.remove();
                    removed++;
                }
            });
            if (removed > 0) setNotificationsCount(Math.max(0, notificationsCount - removed));
        } catch (e) { console.warn('Falha ao limpar notificações por ticket', e); }
    }

    // Inicial render do badge
    renderNotificationsBadge();

    // Inicializa filtro de filas no dropdown
    try { populateTicketQueueFilterList(); } catch(e) { console.warn('Erro ao inicializar filtro de filas', e); }

    // Helper para selecionar sub-abas de inbox sem usar .click() programático
    function selectSubtabPending() {
        try {
            if (currentTicketView !== 'inbox') currentTicketView = 'inbox';
            currentTicketStatus = 'pending';
            currentPage = 1;
            if (tabAguardando) {
                tabAguardando.classList.remove('btn-outline-secondary','btn-success','btn-warning');
                tabAguardando.classList.add('btn-danger');
            }
            if (tabAtendendo) {
                tabAtendendo.classList.remove('btn-success','btn-danger','btn-warning');
                tabAtendendo.classList.add('btn-outline-secondary');
            }
            const tabPendenteLocal = document.getElementById('tab-pendente');
            if (tabPendenteLocal) {
                tabPendenteLocal.classList.remove('btn-warning','btn-success','btn-danger');
                tabPendenteLocal.classList.add('btn-outline-secondary');
            }
            persistState();
            return loadTickets();
        } catch (e) { console.warn('Erro ao selecionar subtab pending', e); return Promise.resolve(); }
    }

    function selectSubtabAtendendo() {
        try {
            if (currentTicketView !== 'inbox') currentTicketView = 'inbox';
            currentTicketStatus = 'attending';
            // Atendendo = verde
            if (tabAtendendo) {
                tabAtendendo.classList.remove('btn-outline-secondary','btn-danger','btn-warning');
                tabAtendendo.classList.add('btn-success');
            }
            if (tabAguardando) {
                tabAguardando.classList.remove('btn-danger','btn-success','btn-warning');
                tabAguardando.classList.add('btn-outline-secondary');
            }
            const tabPendenteLocal = document.getElementById('tab-pendente');
            if (tabPendenteLocal) {
                tabPendenteLocal.classList.remove('btn-warning','btn-success','btn-danger');
                tabPendenteLocal.classList.add('btn-outline-secondary');
            }
            persistState();
            return loadTickets();
        } catch (e) { console.warn('Erro ao selecionar subtab atendendo', e); return Promise.resolve(); }
    }

    function selectTabPendente() {
        try {
            currentTicketView = 'pending';
            currentTicketStatus = 'pending';
            currentPage = 1;
            if (navContatos) navContatos.classList.replace('btn-outline-secondary', 'btn-primary');
            if (navResolved) navResolved.classList.replace('btn-primary', 'btn-outline-secondary');
            const navUnderlineLocal = document.querySelector('.nav-underline');
            if (navUnderlineLocal) navUnderlineLocal.classList.remove('d-none');
            const subTabsContainer2 = document.getElementById('inbox-subtabs-container');
            if (subTabsContainer2) subTabsContainer2.classList.remove('d-none');
            // PENDENTE = amarelo
            const tabPendente = document.getElementById('tab-pendente');
            if (tabPendente) tabPendente.classList.remove('btn-outline-secondary','btn-success','btn-danger');
            if (tabAtendendo) {
                tabAtendendo.classList.remove('btn-success','btn-danger','btn-warning');
                tabAtendendo.classList.add('btn-outline-secondary');
            }
            // Neutraliza outras abas
            if (tabAguardando) {
                tabAguardando.classList.remove('btn-danger','btn-success','btn-warning');
                tabAguardando.classList.add('btn-outline-secondary');
            }
            persistState();
            return loadTickets();
        } catch (e) { console.warn('Erro ao selecionar tab pendente', e); return Promise.resolve(); }
    }

    // Debug helper: observa mudanças nas classes das abas para identificar o que está forçando a troca
    (function initTabChangeObserver(){
        try {
            const watch = [tabAtendendo, tabAguardando, document.getElementById('tab-pendente')].filter(Boolean);
            if (watch.length === 0) return;
            const obs = new MutationObserver((mutations) => {
                mutations.forEach(m => {
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        try {
                            const el = m.target;
                            console.info('[TAB-OBS] Aba alterada:', el.id, 'novaClasse=', el.className);
                            console.info(new Error().stack.split('\n').slice(1,6).join('\n'));
                        } catch(e) { console.warn('TAB-OBS error', e); }
                    }
                });
            });
            watch.forEach(w => obs.observe(w, { attributes: true, attributeFilter: ['class'] }));
            // também loga cliques programáticos
            watch.forEach(w => {
                w.addEventListener('click', () => { console.info('[TAB-OBS] click on', w.id, '\n', new Error().stack.split('\n').slice(1,6).join('\n')); });
            });
        } catch(e) { console.warn('Falha ao inicializar TabChangeObserver', e); }
    })();

    // Ao clicar em um item da lista de notificações, abre o chat correspondente
    try {
        if (notificationsList) {
            notificationsList.addEventListener('click', (ev) => {
                const item = ev.target.closest('.notification-item');
                if (!item) return;
                const ticketId = item.getAttribute('data-ticket-id');
                if (!ticketId) return;
                // Abre chat e limpa notificações deste ticket
                loadChat(ticketId);
                // o loadChat chama clearNotificationsForTicket, que atualiza o contador
            });
        }
    } catch (e) { console.warn('Falha ao registrar listener da notificationsList', e); }

    // Quando o usuário abre a dropdown de notificações (clica no ícone), marca como vistas
    try {
        const notifBtn = document.getElementById('notifications-dropdown');
        if (notifBtn) {
            notifBtn.addEventListener('click', (e) => {
                // Reseta contador ao abrir a dropdown (comportamento desejado para vistas)
                setTimeout(() => setNotificationsCount(0), 150);
            });
        }
    } catch (e) { /* ignore */ }
    const navContatos = document.getElementById('nav-contatos');
    const navResolved = document.getElementById('nav-resolved');
    const navSearch = document.getElementById('nav-search');
    const chatProfilePic = document.getElementById('chat-profile-pic');
    const chatHeader = document.getElementById('chat-header');
    const chatContactName = document.getElementById('chat-contact-name');
    const chatBody = document.getElementById('chat-body');
    const chatForm = document.getElementById('chat-form');
    const chatMessageInput = document.getElementById('chat-message-input');

    // --- Desktop Notifications: solicita permissão e define utilitários ---
    try {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                Notification.requestPermission().then(permission => {
                    console.log('Notification permission:', permission);
                }).catch(e => { console.warn('Falha ao pedir permissão de Notification:', e); });
            }
        }

        function playBeep() {
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx();
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = 'sine';
                o.frequency.value = 1000;
                g.gain.value = 0.05;
                o.connect(g);
                g.connect(ctx.destination);
                o.start();
                setTimeout(() => { try { o.stop(); ctx.close(); } catch (e) {} }, 140);
            } catch (e) { console.warn('playBeep error', e); }
        }

        function showDesktopNotification({ title, body, ticketId }) {
            try {
                if (!('Notification' in window)) return;
                if (Notification.permission !== 'granted') return;

                const opts = {
                    body: body || '',
                    icon: '/assets/logo/phticket-logo.png'
                };
                const n = new Notification(title || 'Nova mensagem', opts);
                n.onclick = (ev) => {
                    try { window.focus(); } catch (e) {}
                    try { if (ticketId) loadChat(ticketId); } catch (e) { console.warn('Erro ao abrir ticket pela notificação', e); }
                    try { n.close(); } catch (e) {}
                };
                // auto-close
                setTimeout(() => { try { n.close(); } catch (e) {} }, 10000);
            } catch (e) { console.warn('showDesktopNotification error', e); }
        }
    } catch (e) { console.warn('Falha ao inicializar desktop notifications:', e); }

    // Controle de tamanho da fonte do sistema (substitui o antigo botão Modo Escuro)
    const fontSizeOptionsSelector = '.font-size-option';
    const fontSizeResetBtnId = 'font-size-reset';
    const FONT_SIZE_KEY = 'appFontSize';

    function applyFontSize(size) {
        try {
            if (!size) return;
            document.documentElement.style.fontSize = size + 'px';
            localStorage.setItem(FONT_SIZE_KEY, String(size));
            // atualiza estado visual dos itens do dropdown
            const opts = document.querySelectorAll(fontSizeOptionsSelector);
            opts.forEach(o => {
                if (o.dataset && o.dataset.size === String(size)) o.classList.add('active');
                else o.classList.remove('active');
            });
        } catch (e) {
            console.warn('Falha ao aplicar tamanho de fonte:', e);
        }
    }

    // Restaura padrão (remove override)
    function resetFontSize() {
        try {
            document.documentElement.style.fontSize = '';
            localStorage.removeItem(FONT_SIZE_KEY);
            const opts = document.querySelectorAll(fontSizeOptionsSelector);
            opts.forEach(o => o.classList.remove('active'));
        } catch (e) {
            console.warn('Falha ao resetar tamanho de fonte:', e);
        }
    }

    // Utilitário simples para escapar HTML em textos dinâmicos
    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Inicializa controle de tamanho de fonte: aplica valor salvo e liga listeners
    (function initFontSizeControl(){
        // Aplica valor salvo se houver
        try {
            const saved = localStorage.getItem(FONT_SIZE_KEY);
            if (saved) {
                applyFontSize(Number(saved));
            }
        } catch (e) {
            console.warn('Erro ao ler tamanho de fonte salvo:', e);
        }

        // Event delegation para opções (o dropdown é criado no HTML)
        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!target) return;
            // Opcões de tamanho
            if (target.classList && target.classList.contains('font-size-option')) {
                ev.preventDefault();
                const s = target.dataset.size;
                if (s) applyFontSize(Number(s));
            }
            // Reset
            if (target.id === fontSizeResetBtnId) {
                ev.preventDefault();
                resetFontSize();
            }
        });
    })();

    // Nota: Fallback de badge de busca de contatos removido — renderização agora depende do listener do input

    // Variável para controlar se deve mostrar notificação aguardando
    let shouldShowAguardando = false;
    // Cache local de contatos para busca client-side
    let contactsCache = [];

    // Elementos do cabeçalho do chat (declarados aqui para garantir que o DOM esteja pronto)
    const chatArea = document.getElementById('chat-area');
    const chatWelcomeMessage = document.getElementById('chat-welcome-message');
    const resolveTicketButton = document.getElementById('resolve-ticket-button');
    const reopenTicketButton = document.getElementById('pendente-ticket-button');
    const transferTicketButton = document.getElementById('transfer-ticket-button');
    const deleteTicketButton = document.getElementById('delete-ticket-button');

    // Utilitários para placeholder do chat
    function showChatPlaceholder() {
        if (chatArea) chatArea.classList.add('d-none');
        if (chatWelcomeMessage) chatWelcomeMessage.classList.remove('d-none');
    }
    function hideChatPlaceholder() {
        if (chatWelcomeMessage) chatWelcomeMessage.classList.add('d-none');
        if (chatArea) chatArea.classList.remove('d-none');
    }

    // Modais
    const addWhatsappModalEl = document.getElementById('addWhatsappModal');
    const addWhatsappModal = new bootstrap.Modal(addWhatsappModalEl);
    const deleteConnectionModalEl = document.getElementById('deleteConnectionModal');
    const deleteConnectionModal = new bootstrap.Modal(deleteConnectionModalEl);
    const editWhatsappModalEl = document.getElementById('editWhatsappModal');
    const editWhatsappModal = new bootstrap.Modal(editWhatsappModalEl);
    const qrCodeModalEl = document.getElementById('qrCodeModal');
    const qrCodeModal = new bootstrap.Modal(qrCodeModalEl);
    const editQueueModalEl = document.getElementById('editQueueModal');
    const editQueueModal = new bootstrap.Modal(editQueueModalEl);
    const deleteQueueModalEl = document.getElementById('deleteQueueModal');
    const deleteQueueModal = new bootstrap.Modal(deleteQueueModalEl);
    const deleteTicketModalEl = document.getElementById('deleteTicketModal');
    const deleteTicketModal = new bootstrap.Modal(deleteTicketModalEl);
    const transferTicketModalEl = document.getElementById('transferTicketModal');
    const transferTicketModal = new bootstrap.Modal(transferTicketModalEl);
    const chatbotConfigModalEl = document.getElementById('chatbotConfigModal');
    const chatbotConfigModal = new bootstrap.Modal(chatbotConfigModalEl);

    // Modais de Respostas Rápidas
    const addQuickResponseModalEl = document.getElementById('addQuickResponseModal');
    const addQuickResponseModal = addQuickResponseModalEl ? new bootstrap.Modal(addQuickResponseModalEl) : null;
    const editQuickResponseModalEl = document.getElementById('editQuickResponseModal');
    const editQuickResponseModal = editQuickResponseModalEl ? new bootstrap.Modal(editQuickResponseModalEl) : null;
    const deleteQuickResponseModalEl = document.getElementById('deleteQuickResponseModal');
    const deleteQuickResponseModal = deleteQuickResponseModalEl ? new bootstrap.Modal(deleteQuickResponseModalEl) : null;

    // Inicia o heartbeat para manter o usuário online
    // Adiciona o listener de envio do formulário do chat
    if (chatForm) {
        chatForm.addEventListener('submit', sendMessage);
    }

    // Permitir Shift+Enter para nova linha e Enter para enviar no campo de mensagem
    if (chatMessageInput) {
        chatMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.shiftKey) {
                // permite o comportamento nativo (inserir newline)
                return;
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // envia o formulário
                if (chatForm) {
                    if (typeof chatForm.requestSubmit === 'function') chatForm.requestSubmit();
                    else chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
                }
            }
        });
    }

    // Debug banner removed — production UI should not show debug overlays
    async function sendHeartbeat() {
        if (!currentUser || !sessionToken) return;
        
        try {
            await fetch('/api/users/heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    userId: currentUser.id, 
                    sessionToken: sessionToken 
                })
            });
        } catch (error) {
            console.error('Erro ao enviar heartbeat:', error);
        }
    }

    // Envia heartbeat a cada 2 minutos
    sendHeartbeat(); // Envia imediatamente ao carregar
    heartbeatInterval = setInterval(sendHeartbeat, 2 * 60 * 1000); // 2 minutos

    // Elementos da seção de Filas
    const addQueueForm = document.getElementById('add-queue-form');

    // --- Respostas Rápidas (UI + CRUD) ---
    const quickResponsesTableBody = document.getElementById('quick-responses-table-body');
    const saveNewQuickResponseBtn = document.getElementById('save-new-quick-response-button');
    const addQrShortcutInput = document.getElementById('add-qr-shortcut');
    const addQrResponseInput = document.getElementById('add-qr-response');
    const saveQuickResponseChangesBtn = document.getElementById('save-quick-response-changes-button');
    const editQrIdInput = document.getElementById('edit-qr-id');
    const editQrShortcutInput = document.getElementById('edit-qr-shortcut');
    const editQrResponseInput = document.getElementById('edit-qr-response');
    const confirmDeleteQuickResponseBtn = document.getElementById('confirm-delete-quick-response-button');
    const quickResponseSearchInput = document.getElementById('quick-response-search-input');
    let quickResponsesCache = [];
    let quickResponseToDelete = null;

    async function loadQuickResponses() {
        try {
            const resp = await fetch(`/api/quick-responses?sessionToken=${sessionToken}`);
            if (!resp.ok) throw new Error('Falha ao carregar respostas rápidas');
            quickResponsesCache = await resp.json();
            renderQuickResponses(quickResponsesCache);
        } catch (e) {
            console.error('Erro ao carregar respostas rápidas:', e);
            showNotification('Erro ao carregar respostas rápidas.', 'danger');
        }
    }

    function renderQuickResponses(list) {
        if (!quickResponsesTableBody) return;
        quickResponsesTableBody.innerHTML = '';
        if (!list || list.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="3" class="text-center text-muted">Nenhuma resposta rápida cadastrada.</td>`;
            quickResponsesTableBody.appendChild(tr);
            return;
        }
        list.forEach(qr => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${escapeHtml(qr.shortcut)}</code></td>
                <td class="text-break">${escapeHtml(qr.response)}</td>
                <td class="text-nowrap">
                    <button class="btn btn-sm btn-info me-1" title="Editar" data-action="edit" data-id="${qr.id}"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-danger" title="Excluir" data-action="delete" data-id="${qr.id}"><i class="bi bi-trash"></i></button>
                </td>
            `;
            quickResponsesTableBody.appendChild(tr);
        });

        // Delegação de eventos para ações de editar/excluir
        quickResponsesTableBody.querySelectorAll('button[data-action]')
            .forEach(btn => btn.addEventListener('click', onQuickResponseAction));
    }

    function onQuickResponseAction(e) {
        const btn = e.currentTarget;
        const id = Number(btn.getAttribute('data-id'));
        const action = btn.getAttribute('data-action');
        const found = quickResponsesCache.find(q => q.id === id);
        if (!found) return;
        if (action === 'edit') {
            if (editQrIdInput) editQrIdInput.value = String(found.id);
            if (editQrShortcutInput) editQrShortcutInput.value = found.shortcut || '';
            if (editQrResponseInput) editQrResponseInput.value = found.response || '';
            if (editQuickResponseModal) editQuickResponseModal.show();
        } else if (action === 'delete') {
            quickResponseToDelete = found.id;
            if (deleteQuickResponseModal) deleteQuickResponseModal.show();
        }
    }

    if (saveNewQuickResponseBtn) {
        saveNewQuickResponseBtn.addEventListener('click', async () => {
            const sc = (addQrShortcutInput && addQrShortcutInput.value || '').trim();
            const rp = (addQrResponseInput && addQrResponseInput.value || '').trim();
            if (!sc || !rp) return showNotification('Preencha atalho e resposta.', 'warning');
            try {
                const resp = await fetch('/api/quick-responses', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shortcut: sc, response: rp, sessionToken: sessionToken })
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data && data.error ? data.error : 'Falha ao salvar');
                showNotification('Resposta rápida adicionada.', 'success');
                if (addQuickResponseModal) addQuickResponseModal.hide();
                if (addQrShortcutInput) addQrShortcutInput.value = '';
                if (addQrResponseInput) addQrResponseInput.value = '';
                await loadQuickResponses();
            } catch (err) {
                showNotification(`Erro ao adicionar: ${err.message}`, 'danger');
            }
        });
    }

    if (saveQuickResponseChangesBtn) {
        saveQuickResponseChangesBtn.addEventListener('click', async () => {
            const id = Number(editQrIdInput && editQrIdInput.value);
            const sc = (editQrShortcutInput && editQrShortcutInput.value || '').trim();
            const rp = (editQrResponseInput && editQrResponseInput.value || '').trim();
            if (!id) return;
            try {
                const resp = await fetch(`/api/quick-responses/${id}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shortcut: sc, response: rp, sessionToken: sessionToken })
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data && data.error ? data.error : 'Falha ao atualizar');
                showNotification('Resposta rápida atualizada.', 'success');
                if (editQuickResponseModal) editQuickResponseModal.hide();
                await loadQuickResponses();
            } catch (err) {
                showNotification(`Erro ao atualizar: ${err.message}`, 'danger');
            }
        });
    }

    if (confirmDeleteQuickResponseBtn) {
        confirmDeleteQuickResponseBtn.addEventListener('click', async () => {
            if (!quickResponseToDelete) return;
            try {
                const resp = await fetch(`/api/quick-responses/${quickResponseToDelete}?sessionToken=${sessionToken}`, { method: 'DELETE' });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data && data.error ? data.error : 'Falha ao excluir');
                showNotification('Resposta rápida excluída.', 'success');
                quickResponseToDelete = null;
                if (deleteQuickResponseModal) deleteQuickResponseModal.hide();
                await loadQuickResponses();
            } catch (err) {
                showNotification(`Erro ao excluir: ${err.message}`, 'danger');
            }
        });
    }

    if (quickResponseSearchInput) {
        quickResponseSearchInput.addEventListener('input', (e) => {
            const q = String(e.target.value || '').toLowerCase();
            const filtered = !q ? quickResponsesCache : quickResponsesCache.filter(r =>
                (r.shortcut || '').toLowerCase().includes(q) || (r.response || '').toLowerCase().includes(q)
            );
            renderQuickResponses(filtered);
        });
    }

    // Sugestões de respostas rápidas no input do chat
    const quickResponseSuggestionsEl = document.getElementById('quick-response-suggestions');
    function hideQuickResponseSuggestions() {
        if (quickResponseSuggestionsEl) quickResponseSuggestionsEl.classList.add('d-none');
        if (quickResponseSuggestionsEl) quickResponseSuggestionsEl.innerHTML = '';
    }
    function showQuickResponseSuggestions(items) {
        if (!quickResponseSuggestionsEl) return;
        if (!items || items.length === 0) return hideQuickResponseSuggestions();
        quickResponseSuggestionsEl.innerHTML = '';
        items.slice(0, 8).forEach(it => {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'list-group-item list-group-item-action';
            a.innerHTML = `<strong>${escapeHtml(it.shortcut)}</strong><div class="small text-muted">${escapeHtml(it.response)}</div>`;
            a.addEventListener('click', (ev) => {
                ev.preventDefault();
                if (chatMessageInput) chatMessageInput.value = it.response || '';
                hideQuickResponseSuggestions();
                chatMessageInput && chatMessageInput.focus();
            });
            quickResponseSuggestionsEl.appendChild(a);
        });
        quickResponseSuggestionsEl.classList.remove('d-none');
    }

    async function ensureQuickResponsesLoaded() {
        if (!quickResponsesCache || quickResponsesCache.length === 0) {
            try { await loadQuickResponses(); } catch (_) {}
        }
    }

    if (chatMessageInput) {
        chatMessageInput.addEventListener('input', async () => {
            const val = (chatMessageInput.value || '').trim();
            if (!val.startsWith('\\')) { hideQuickResponseSuggestions(); return; }
            // Carrega se necessário
            await ensureQuickResponsesLoaded();
            const query = val.toLowerCase();
            const matches = quickResponsesCache.filter(r => (r.shortcut || '').toLowerCase().startsWith(query));
            showQuickResponseSuggestions(matches);
        });
        chatMessageInput.addEventListener('blur', () => setTimeout(hideQuickResponseSuggestions, 150));
    }

    // --- NOVO: Botões e modal de pesquisa profissional de usuários ---
    const userSearchButton = document.getElementById('user-search-button');
    const userSearchRun = document.getElementById('user-search-run');
    const userSearchModalEl = document.getElementById('userSearchModal');
    const userSearchModal = userSearchModalEl ? new bootstrap.Modal(userSearchModalEl) : null;
    const userSearchResultsBody = document.getElementById('user-search-results-body');

    function profileBadgeHtml(profile) {
        switch(profile) {
            case 'admin': return '<span class="badge bg-danger">Administrador</span>';
            case 'supervisor': return '<span class="badge bg-warning">Supervisor</span>';
            default: return '<span class="badge bg-info">Usuário</span>';
        }
    }

    async function performUserSearch(query) {
        try {
            const resp = await fetch('/api/users');
            if (!resp.ok) throw new Error('Falha ao obter usuários');
            const users = await resp.json();
            const q = String(query || '').trim().toLowerCase();
            const filtered = q ? users.filter(u => (u.name||'').toLowerCase().includes(q) || (u.email||'').toLowerCase().includes(q)) : users;

            if (userSearchResultsBody) {
                userSearchResultsBody.innerHTML = '';
                filtered.forEach(user => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${user.name}</td>
                        <td>${user.email}</td>
                        <td>${profileBadgeHtml(user.profile)}</td>
                        <td>${(user.queue_names && user.queue_names.join(', ')) || '-'}</td>
                        <td>
                            <button class="btn btn-sm btn-info edit-user-btn" data-id="${user.id}" title="Editar"><i class="bi bi-pencil"></i></button>
                            <button class="btn btn-sm btn-danger delete-user-btn" data-id="${user.id}" title="Excluir"><i class="bi bi-trash"></i></button>
                        </td>
                    `;
                    userSearchResultsBody.appendChild(tr);
                });
            }

            return filtered;
        } catch (e) {
            console.error('Erro na busca de usuários:', e);
            showNotification('Erro ao buscar usuários', 'danger');
            return [];
        }
    }

    if (userSearchButton) {
        userSearchButton.addEventListener('click', (e) => {
            e.preventDefault();
            if (userSearchModal) {
                userSearchModal.show();
                setTimeout(() => {
                    const input = document.getElementById('user-search-modal-input');
                    if (input) input.focus();
                }, 200);
            }
        });
    }

    if (userSearchRun) {
        userSearchRun.addEventListener('click', (e) => {
            e.preventDefault();
            if (userSearchModal) {
                userSearchModal.show();
                setTimeout(() => {
                    const input = document.getElementById('user-search-modal-input');
                    if (input) input.focus();
                }, 200);
            }
        });
    }

    // Click do botão dentro do modal
    document.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!target) return;
        if (target.id === 'user-search-modal-run' || target.closest && target.closest('#user-search-modal-run')) {
            ev.preventDefault();
            const q = (document.getElementById('user-search-modal-input') || {}).value || '';
            performUserSearch(q);
        }
        if (target.id === 'user-search-apply') {
            ev.preventDefault();
            const q = (document.getElementById('user-search-modal-input') || {}).value || '';
            performUserSearch(q).then(filtered => {
                // Aplica filtro na tabela principal de usuários
                const tableBody = document.getElementById('users-table-body');
                if (tableBody) {
                    tableBody.innerHTML = '';
                    filtered.forEach(user => {
                        const row = document.createElement('tr');
                        row.innerHTML = `
                            <td>${user.name}</td>
                            <td>${user.email}</td>
                            <td>${profileBadgeHtml(user.profile)}</td>
                            <td>${(user.queue_names && user.queue_names.join(', ')) || '-'}</td>
                            <td class="user-actions">
                                <button class="btn btn-sm btn-info edit-user-btn" data-id="${user.id}" title="Editar"><i class="bi bi-pencil"></i></button>
                                <button class="btn btn-sm btn-danger delete-user-btn" data-id="${user.id}" title="Excluir"><i class="bi bi-trash"></i></button>
                            </td>
                        `;
                        tableBody.appendChild(row);
                    });
                }
                if (userSearchModal) userSearchModal.hide();
            });
        }
    });


    // Mostrar item de menu "Mensagens & Filas" para administradores/supervisores
    try {
        if (menuWhatsappSettingsItem && currentUser && (currentUser.profile === 'admin' || currentUser.profile === 'supervisor')) {
            menuWhatsappSettingsItem.style.display = '';
        }
    } catch (e) {
        console.error('Erro ao ajustar visibilidade do menu Whatsapp Settings:', e);
    }

    // Mostrar item de menu "Permissões" apenas para administradores
    try {
        const menuPermissoesItem = document.getElementById('menu-permissoes-item');
        if (menuPermissoesItem && currentUser && currentUser.profile === 'admin') {
            menuPermissoesItem.style.display = '';
        }
    } catch (e) {
        console.error('Erro ao ajustar visibilidade do menu Permissões:', e);
    }

    // Listener para evento de busca de protocolo
    document.addEventListener('loadChatFromSearch', async (e) => {
        const ticketId = e.detail;
        if (ticketId) {
            await loadTickets('all');
            currentTicketId = ticketId;
            await loadChat(ticketId);
        }
    });

    // Busca de Protocolo: a lógica foi movida para dashboard-search.js
    const queuesTableBody = document.getElementById('queues-table-body');

    // Formulário de Adicionar
    const addWhatsappForm = {
        form: document.getElementById('addWhatsappModal').querySelector('form'),
        name: document.getElementById('add-whatsapp-name'),
        is_default: document.getElementById('add-whatsapp-default'),
        startTime: document.getElementById('add-whatsapp-start-time'),
        endTime: document.getElementById('add-whatsapp-end-time'),
        initialMessage: document.getElementById('add-whatsapp-initial-message'),
        farewellMessage: document.getElementById('add-whatsapp-farewell-message'),
        queuesContainer: document.getElementById('add-whatsapp-queues-container')
    };

    // Formulário de Editar
    const editWhatsappForm = {
        button: document.getElementById('save-edit-button'),
        id: document.getElementById('edit-whatsapp-id'),
        name: document.getElementById('edit-whatsapp-name'),
        is_default: document.getElementById('edit-whatsapp-default'),
        startTime: document.getElementById('edit-whatsapp-start-time'),
        endTime: document.getElementById('edit-whatsapp-end-time'),
        initialMessage: document.getElementById('edit-whatsapp-initial-message'),
        farewellMessage: document.getElementById('edit-whatsapp-farewell-message'),
        queuesContainer: document.getElementById('edit-whatsapp-queues-container')
    };

    // --- Persistência das mensagens do modal Adicionar WhatsApp (localStorage) ---
    const ADD_WHATSAPP_MESSAGES_KEY = `add_whatsapp_messages_${currentUser && currentUser.id ? currentUser.id : 'anon'}`;

    function saveAddWhatsappMessages() {
        try {
            const data = {
                initialMessage: addWhatsappForm.initialMessage ? addWhatsappForm.initialMessage.value : '',
                farewellMessage: addWhatsappForm.farewellMessage ? addWhatsappForm.farewellMessage.value : '',
                timestamp: Date.now()
            };
            localStorage.setItem(ADD_WHATSAPP_MESSAGES_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('Não foi possível salvar mensagens do modal Adicionar WhatsApp:', e);
        }
    }

    function loadAddWhatsappMessages() {
        try {
            const raw = localStorage.getItem(ADD_WHATSAPP_MESSAGES_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (addWhatsappForm.initialMessage && data.initialMessage) {
                addWhatsappForm.initialMessage.value = data.initialMessage;
            }
            if (addWhatsappForm.farewellMessage && data.farewellMessage) {
                addWhatsappForm.farewellMessage.value = data.farewellMessage;
            }
        } catch (e) {
            console.warn('Erro ao carregar mensagens do modal Adicionar WhatsApp:', e);
        }
    }

    // Event listeners para salvar automaticamente as mensagens quando o usuário digita
    if (addWhatsappForm.initialMessage) {
        addWhatsappForm.initialMessage.addEventListener('input', saveAddWhatsappMessages);
    }
    if (addWhatsappForm.farewellMessage) {
        addWhatsappForm.farewellMessage.addEventListener('input', saveAddWhatsappMessages);
    }

    // Carrega as mensagens salvas quando a página é carregada
    loadAddWhatsappMessages();

    // Botão de confirmação de exclusão
    const confirmDeleteButton = document.getElementById('confirm-delete-button');
    const confirmDeleteTicketButton = document.getElementById('confirm-delete-ticket-button');
    let connectionIdToDelete = null;
    let queueIdToDelete = null;
    let ticketIdToDelete = null; // Variável para armazenar o ID do ticket a ser excluído
    let connectionToEdit = null;
    let activeQrConnectionId = null; // Rastreia qual conexão está esperando um QR Code
    // Map para armazenar interval IDs de polling do QR por connection id,
    // assim podemos limpar o polling quando a conexão for autenticada.
    const qrPollingIntervals = {};

    // Conecta ao WebSocket
    // Conecta ao WebSocket, especificando o endereço do servidor para maior robustez.
        const socket = io({
            transports: ['websocket', 'polling'], // força WebSocket primário com fallback para polling
            reconnection: true,
            reconnectionAttempts: 10, // tenta reconectar até 10 vezes
            reconnectionDelay: 1000, // 1s entre tentativas iniciais
            reconnectionDelayMax: 5000, // até 5s
            randomizationFactor: 0.5,
            timeout: 20000 // tempo máximo para tentativa de conexão inicial
        });

        // Helper para mostrar estado de conexão na UI (badge, título, etc.)
        function setConnectionStatus(status) {
            const statusBadge = document.getElementById('socket-status-badge');
            if (statusBadge) {
                statusBadge.textContent = status;
                if (status === 'Conectado') {
                    statusBadge.className = 'badge bg-success';
                } else if (status === 'Reconectando') {
                    statusBadge.className = 'badge bg-warning text-dark';
                } else {
                    statusBadge.className = 'badge bg-danger';
                }
            }
        }

        // Eventos de conexão — NÃO recarregar a página aqui!
        socket.on('connect', () => {
            console.log('Socket conectado', socket.id);
            setConnectionStatus('Conectado');
        });

        socket.on('connect_error', (err) => {
            console.warn('Erro ao conectar socket:', err && err.message ? err.message : err);
            setConnectionStatus('Desconectado');
            // Não recarregar nem redirecionar — deixamos o socket tentar reconectar automaticamente.
        });

        socket.on('reconnect_attempt', (attempt) => {
            console.info('Tentativa de reconexão #', attempt);
            setConnectionStatus('Reconectando');
        });

        socket.on('reconnect_failed', () => {
            console.error('Re conexão falhou após várias tentativas.');
            setConnectionStatus('Desconectado');
            // Podemos notificar o usuário com um toast/modal em vez de recarregar.
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket desconectado:', reason);
            setConnectionStatus('Desconectado');
            // Temporariamente, não fazemos nada que cause reload da página.
        });

    // Estado da UI de tickets (persistente via localStorage)
    function lsGetJSON(key, def){
        try { const v = ls.getItem(key); return v ? JSON.parse(v) : def; } catch(e){ return def; }
    }
    // Helper para construir parâmetros de usuário (user_id + queue_ids) de forma consistente
    function buildUserParams() {
        if (currentUser && currentUser.id && currentUser.queue_ids && currentUser.queue_ids.length > 0) {
            return `&user_id=${currentUser.id}&queue_ids=${currentUser.queue_ids.join(',')}`;
        }
        if (currentUser && currentUser.id) {
            return `&user_id=${currentUser.id}`;
        }
        return '';
    }
    function persistState(){
        try {
            ls.setItem('chat_state', JSON.stringify({
                currentSection,
                currentTicketView,
                currentTicketStatus,
                activeTicketId,
                selectedChatUser: window.selectedChatUser,
                scrollPos: ticketListContainer ? ticketListContainer.scrollTop : 0
            }));
        } catch(e){ /* ignore */ }
    }
    let { currentSection = 'ingressos', currentTicketView = 'inbox', currentTicketStatus = 'attending', activeTicketId = null, selectedChatUser = null } = lsGetJSON('chat_state', {});
    window.selectedChatUser = selectedChatUser;
    let connectionPollingInterval = null; // Variável para controlar o loop de atualização das conexões

    let ticketsChart = null; // Variável para armazenar a instância do gráfico
    let supportsOnHoldFilter = true; // Detecta se o backend já possui a coluna is_on_hold
    
    // Variáveis de paginação
    let currentPage = 1;
    const itemsPerPage = 6;
    
    // --- FUNÇÕES ---
    
    // Função para obter a cor e o texto do badge de status
    function getStatusBadge(status) {
        switch(status) {
            case 'CONNECTED':
                return '<span class="badge bg-success">Conectado</span>';
            case 'QR_PENDING':
                return '<span class="badge bg-warning text-dark">Aguardando QR Code</span>';
            case 'DISCONNECTED':
            default:
                return '<span class="badge bg-danger">Desconectado</span>';
        }
    }

    // Carrega e renderiza as conexões na tabela
    async function loadConnections() {
        try {
            const response = await fetch('/api/connections');
            if (!response.ok) throw new Error('Falha ao carregar conexões');
            const connections = await response.json();
            
            connectionsTableBody.innerHTML = ''; // Limpa a tabela
            connections.forEach(renderConnectionRow);
            
            // Desabilita o botão "Adicionar WhatsApp" se já existir alguma conexão
            const addWhatsappBtn = document.getElementById('add-whatsapp-btn');
            if (addWhatsappBtn) {
                if (connections.length > 0) {
                    addWhatsappBtn.disabled = true;
                    addWhatsappBtn.classList.add('disabled');
                    addWhatsappBtn.title = 'Já existe uma conexão cadastrada';
                } else {
                    addWhatsappBtn.disabled = false;
                    addWhatsappBtn.classList.remove('disabled');
                    addWhatsappBtn.title = 'Adicionar WhatsApp';
                }
            }
        } catch (error) {
            console.error('Erro ao carregar conexões:', error);
            showNotification('Não foi possível carregar as conexões.', 'danger');
        }
    }

    // Renderiza uma linha na tabela de conexões
    function renderConnectionRow(conn) {
        let row = connectionsTableBody.querySelector(`[data-conn-id='${conn.id}']`);
        // Se a linha não existir, cria uma nova. Caso contrário, atualiza a existente.
        if (!row) {
            row = connectionsTableBody.insertRow();
            row.setAttribute('data-conn-id', conn.id);
        }

        const statusBadge = getStatusBadge(conn.status);

        // Define quais botões de ação devem aparecer com base no status
        const actionsHtml = `
            <button class="btn btn-sm btn-info me-1 edit-btn" data-id="${conn.id}" title="Editar"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-danger delete-btn" data-id="${conn.id}" title="Excluir"><i class="bi bi-trash"></i></button>
        `;

        row.innerHTML = `
            <td>${conn.name}</td>
            <td class="status-cell">${statusBadge}</td>
            <td>${new Date(conn.last_updated_at).toLocaleString('pt-BR')}</td>
            <td>${conn.is_default ? 'Sim' : 'Não'}</td>
            <td>${actionsHtml}</td>
        `;
    }

    // Adiciona uma nova conexão
    async function addConnection(event) {
        event.preventDefault(); // Impede o recarregamento da página
        
        const queueCheckboxes = addWhatsappForm.queuesContainer 
            ? addWhatsappForm.queuesContainer.querySelectorAll('input[type="checkbox"]:checked')
            : [];
        
        const connectionData = {
            name: addWhatsappForm.name.value,
            is_default: addWhatsappForm.is_default.checked,
            start_time: addWhatsappForm.startTime ? addWhatsappForm.startTime.value : null,
            end_time: addWhatsappForm.endTime ? addWhatsappForm.endTime.value : null,
            birthday_message: addWhatsappForm.initialMessage ? addWhatsappForm.initialMessage.value : null,
            farewell_message: addWhatsappForm.farewellMessage ? addWhatsappForm.farewellMessage.value : null,
            queue_ids: Array.from(queueCheckboxes).map(cb => cb.value)
        };

        if (!connectionData.name) {
            showNotification('O nome da conexão é obrigatório.', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/connections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(connectionData)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao adicionar a conexão.');
            }

            const newConnection = await response.json();
            // A API de criação agora retorna o status, então podemos usar a mesma função
            const connectionWithStatus = { ...newConnection, status: 'DISCONNECTED' };
            renderConnectionRow(connectionWithStatus);

            addWhatsappModal.hide();
            
            // Reset apenas do nome e checkbox padrão, mantém as mensagens
            addWhatsappForm.name.value = '';
            addWhatsappForm.is_default.checked = true;
            // NÃO resetar initialMessage e farewellMessage - eles são preservados
            
            // Recarregar as filas para resetar os checkboxes
            await populateQueueCheckboxes();

            // Inicia a conexão para gerar o QR Code imediatamente
            initConnection(newConnection.id);
        } catch (error) {
            console.error('Erro ao adicionar conexão:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Inicia a conexão e mostra o QR Code
    async function initConnection(id) {
        activeQrConnectionId = parseInt(id, 10); // Garante que o ID seja um número
        const qrContainer = document.getElementById('qrcode-container');
        qrContainer.innerHTML = '<div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div>';
        qrCodeModal.show();

        // Atualiza a UI para mostrar que está aguardando o QR Code
        const row = connectionsTableBody.querySelector(`[data-conn-id='${id}']`);
        if (row) {
            const statusCell = row.querySelector('.status-cell');
            if (statusCell) statusCell.innerHTML = getStatusBadge('QR_PENDING');
        }

        try {
            // Apenas envia a requisição para iniciar, o QR virá por WebSocket
            const response = await fetch(`/api/connections/${id}/init`, {
                method: 'POST'
            });

            // A resposta esperada é 202 (Accepted), que indica que o processo começou.
            // Qualquer outra coisa fora da faixa 2xx é um erro.
            if (response.status < 200 || response.status >= 300) {
                let errorMsg = 'Falha ao iniciar a conexão.';
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.error || errorData.message || errorMsg;
                } catch (e) { /* Ignora erro de parsing se a resposta não for JSON */ }
                throw new Error(errorMsg);
            }
            // Não fazemos mais nada aqui, a resposta de sucesso é apenas uma confirmação.
            // O QR Code será recebido pelo listener do WebSocket.
        } catch (error) {
            qrContainer.innerHTML = `<p class="text-danger"><b>Erro ao iniciar:</b><br>${error.message}</p>`;
        }

        // Inicia o polling para buscar o QR Code
        // Armazenamos o interval em `qrPollingIntervals` para permitir cancelamento
        // a partir de outros handlers (ex: socket 'connection_update').
        let pollingIntervalId = null;

        pollingIntervalId = setInterval(async () => {
            // Se o modal foi fechado, para de fazer polling
            if (!qrCodeModalEl.classList.contains('show') || activeQrConnectionId !== id) {
                clearInterval(pollingIntervalId);
                try { delete qrPollingIntervals[id]; } catch (e) { /* ignore */ }
                return;
            }

            try {
                const pollResponse = await fetch(`/api/connections/${id}/qr`);
                if (pollResponse.status === 200) { // 200 OK = QR Code pronto
                    const data = await pollResponse.json();
                        if (data.qrUrl) {
                        qrContainer.innerHTML = `<img src="${data.qrUrl}" alt="QR Code do WhatsApp" /><p class="text-muted small mt-2">Escaneie o QR Code usando o aplicativo WhatsApp.</p>`;
                        clearInterval(pollingIntervalId); // Para de perguntar até o próximo ciclo
                        try { delete qrPollingIntervals[id]; } catch (e) { /* ignore */ }
                    }
                } else if (pollResponse.status === 202) { // 202 = Aguardando geração do QR
                    const data = await pollResponse.json();
                    qrContainer.innerHTML = `<div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="text-muted mt-2">${data.message || 'Aguardando QR Code...'}</p>`;
                    // Continua o polling
                } else if (pollResponse.status === 500) { // Erro no servidor (ex: timeout)
                    const errorData = await pollResponse.json();
                    qrContainer.innerHTML = `<p class="text-danger"><b>Falha ao gerar QR Code:</b><br>${errorData.message}</p>`;
                    clearInterval(pollingIntervalId);
                    try { delete qrPollingIntervals[id]; } catch (e) { /* ignore */ }
                }
            } catch (error) {
                console.error('Erro no polling do QR Code:', error);
                qrContainer.innerHTML = `<p class="text-danger"><b>Erro de comunicação:</b><br>Não foi possível obter o QR Code.</p>`;
                clearInterval(pollingIntervalId);
                try { delete qrPollingIntervals[id]; } catch (e) { /* ignore */ }
            }
        }, 2000); // Pergunta a cada 2 segundos

        // Salva referência do intervalo para permitir cancelamento externo
        try { qrPollingIntervals[id] = pollingIntervalId; } catch (e) { /* ignore */ }
    }

    // Preenche o modal de edição
    async function openEditModal(id) {
        try {
            // Primeiro, popula as filas disponíveis
            await populateQueueCheckboxes();
            
            const response = await fetch(`/api/connections/${id}`);
            if (!response.ok) {
                let errorMessage = 'Falha ao buscar dados da conexão.';
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.message || errorData.error || errorMessage;
                } catch (e) {
                    // A resposta não era JSON, o que pode acontecer em erros de servidor (500)
                }
                throw new Error(errorMessage);
            }
            
            const conn = await response.json();

            // Preenche o formulário
            editWhatsappForm.id.value = conn.id;
            editWhatsappForm.name.value = conn.name;
            editWhatsappForm.is_default.checked = !!conn.is_default;
            editWhatsappForm.startTime.value = conn.start_time || '';
            editWhatsappForm.endTime.value = conn.end_time || '';
            editWhatsappForm.initialMessage.value = conn.birthday_message || '';
            editWhatsappForm.farewellMessage.value = conn.farewell_message || '';
            
            // Marca as filas selecionadas
            if (editWhatsappForm.queuesContainer) {
                const queueCheckboxes = editWhatsappForm.queuesContainer.querySelectorAll('input[type="checkbox"]');
                const hasQueueIds = Array.isArray(conn.queue_ids) && conn.queue_ids.length > 0;
                queueCheckboxes.forEach(cb => {
                    if (hasQueueIds) {
                        cb.checked = conn.queue_ids.includes(parseInt(cb.value, 10));
                    } else {
                        // Se não tem filas, marca todas por padrão
                        cb.checked = true;
                    }
                });
            }

            editWhatsappModal.show();
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Salva as alterações da conexão
    async function saveConnectionChanges() {
        const id = editWhatsappForm.id.value;
        
        const queueCheckboxes = editWhatsappForm.queuesContainer 
            ? editWhatsappForm.queuesContainer.querySelectorAll('input[type="checkbox"]:checked')
            : [];
        
        const updatedData = {
            name: editWhatsappForm.name.value,
            is_default: editWhatsappForm.is_default.checked,
            start_time: editWhatsappForm.startTime ? editWhatsappForm.startTime.value : null,
            end_time: editWhatsappForm.endTime ? editWhatsappForm.endTime.value : null,
            birthday_message: editWhatsappForm.initialMessage ? editWhatsappForm.initialMessage.value : null,
            farewell_message: editWhatsappForm.farewellMessage ? editWhatsappForm.farewellMessage.value : null,
            queue_ids: Array.from(queueCheckboxes).map(cb => cb.value)
        };

        if (!updatedData.name) {
            showNotification('O nome da conexão é obrigatório.', 'warning');
            return;
        }

        try {
            const response = await fetch(`/api/connections/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedData)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao salvar as alterações.');
            }

            const updatedConnection = await response.json();

            // Em vez de recarregar tudo, vamos atualizar a linha existente
            const rowToUpdate = connectionsTableBody.querySelector(`[data-conn-id='${id}']`);
            if (rowToUpdate) {
                rowToUpdate.cells[0].textContent = updatedConnection.name;
                // A célula 2 é a 'Última Atualização', que agora será atualizada no DB.
                rowToUpdate.cells[3].textContent = updatedConnection.is_default ? 'Sim' : 'Não'; // Célula 3 é 'Padrão'
            }

            editWhatsappModal.hide();
            showNotification('Conexão atualizada com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Exclui uma conexão
    async function deleteConnection() {
        if (!connectionIdToDelete) return;

        try {
            const response = await fetch(`/api/connections/${connectionIdToDelete}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Falha ao excluir a conexão.');
            }

            // Não é necessário processar a resposta como JSON em caso de sucesso,
            // pois a resposta DELETE bem-sucedida (204 No Content) não tem corpo.

            // Remove a linha da tabela
            const rowToRemove = connectionsTableBody.querySelector(`[data-conn-id='${connectionIdToDelete}']`);
            if (rowToRemove) rowToRemove.remove();

            deleteConnectionModal.hide();
            showNotification('Conexão excluída com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        } finally {
            connectionIdToDelete = null;
        }
    }

    // Desconecta uma sessão
    async function disconnectConnection(id) {
        const okDisconnect = await showConfirm('Tem certeza que deseja desconectar esta sessão? Você precisará escanear o QR Code novamente para reconectar.', 'Desconectar sessão');
        if (!okDisconnect) return;

        try {
            const response = await fetch(`/api/connections/${id}/disconnect`, {
                method: 'POST'
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Falha ao desconectar a sessão.');
            }

            showNotification('Sessão desconectada com sucesso.', 'success');
            // A UI será atualizada pelo evento do WebSocket 'connection_update'
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Ativa o item de menu correto
    function activateMenuItem(itemToActivate) {
        document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
        if (itemToActivate) {
            itemToActivate.classList.add('active');
        }
    }

    // Navega entre as seções (Painel, Conexões, etc.)
    function navigateTo(section) {
        currentSection = section;
        painelContent.classList.add('d-none');
        conexoesContent.classList.add('d-none');
        ingressosContent.classList.add('d-none');
        filasContent.classList.add('d-none');
        if (usuariosContent) usuariosContent.classList.add('d-none');
        if (contatosContent) contatosContent.classList.add('d-none');
        if (respostasRapidasContent) respostasRapidasContent.classList.add('d-none');
        if (chatInternoContent) chatInternoContent.classList.add('d-none');
        mainHeader.classList.remove('d-none'); // Mostra o cabeçalho por padrão

        // Para o loop de atualização de conexões ao sair da tela específica
        if (connectionPollingInterval) {
            clearInterval(connectionPollingInterval);
            connectionPollingInterval = null;
        }

        // Para o loop de atualização de usuários online
        if (onlineUsersInterval) {
            clearInterval(onlineUsersInterval);
            onlineUsersInterval = null;
        }

        // Ao sair do Chat Interno, limpa o usuário selecionado para evitar marcar mensagens como lidas
        if (section !== 'chat-interno') {
            window.selectedChatUser = null;
        }
        // Para o loop de atualização de contadores de não lidas
        if (unreadCountsInterval) {
            clearInterval(unreadCountsInterval);
            unreadCountsInterval = null;
        }

        if (section === 'painel') {
            painelContent.classList.remove('d-none');
            mainTitle.textContent = 'Painel Principal';
            activateMenuItem(menuPainel);
            // Popula o filtro de usuários e atualiza as estatísticas
            try { populateDashboardUsersFilter(); } catch (_) {}
            updateDashboardStats();
        } else if (section === 'conexoes') {
            conexoesContent.classList.remove('d-none');
            mainTitle.textContent = 'Conexões';
            activateMenuItem(menuConexoes);
            loadConnections();
            // Inicia um loop de segurança para atualizar a cada 15 segundos
            connectionPollingInterval = setInterval(loadConnections, 15000);
            populateQueueCheckboxes(); // Carrega as filas nos modais
        } else if (section === 'ingressos') {
            // Esconde o cabeçalho principal e o título, pois a seção de ingressos tem o seu próprio
            mainHeader.classList.add('d-none');

            ingressosContent.classList.remove('d-none');
            activateMenuItem(menuIngressos);
            // Ao entrar em Atendimentos, sempre reinicia o chat até que um ticket seja escolhido
            activeTicketId = null;
            persistState();
            showChatPlaceholder();
            loadTickets();
        } else if (section === 'filas') {
            filasContent.classList.remove('d-none');
            mainTitle.textContent = 'Filas e Departamentos';
            activateMenuItem(menuFilas);
            loadQueues();
        } else if (section === 'usuarios') {
            if (usuariosContent) {
                usuariosContent.classList.remove('d-none');
                mainTitle.textContent = 'Usuários';
                activateMenuItem(menuUsuarios);
                loadUsers();
            }
        } else if (section === 'contatos') {
            if (contatosContent) {
                contatosContent.classList.remove('d-none');
                mainTitle.textContent = 'Contatos';
                activateMenuItem(menuContatos);
                loadContacts();
            }
        } else if (section === 'respostas-rapidas') {
            if (respostasRapidasContent) {
                respostasRapidasContent.classList.remove('d-none');
                mainTitle.textContent = 'Respostas Rápidas';
                activateMenuItem(menuRespostasRapidas);
                // Carrega a lista ao entrar na tela
                try { loadQuickResponses(); } catch (_) {}
            }
        } else if (section === 'chat-interno') {
            if (chatInternoContent) {
                chatInternoContent.classList.remove('d-none');
                mainTitle.textContent = 'Chat Interno';
                activateMenuItem(menuChatInterno);
                // Remove a piscada do menu ao entrar no Chat Interno
                const menuChatInternoBtn = document.getElementById('menu-chat-interno');
                if (menuChatInternoBtn) {
                    menuChatInternoBtn.classList.remove('chat-interno-notification');
                }
                // Reseta o chat para o estado padrão apenas se não houver usuário selecionado
                if (!window.selectedChatUser) {
                    resetChatArea();
                } else {
                    // Restaura o estado do chat se houver usuário selecionado
                    restoreChatState();
                }
                // Busca contadores de não lidas antes de renderizar listas
                fetchUnreadCounts();
                loadOnlineUsers();
                // Atualiza a lista de usuários online e contadores de não lidas a cada 10 segundos
                onlineUsersInterval = setInterval(loadOnlineUsers, 10000);
                unreadCountsInterval = setInterval(fetchUnreadCounts, 10000);
            }
        }
        persistState();
    }

    // Verifica se a tela do Chat Interno está visível
    function isChatInternoVisible() {
        return chatInternoContent && !chatInternoContent.classList.contains('d-none');
    }

    // Lê filtros atuais do painel
    function getDashboardFilters() {
        const dateStart = filterDateStartInput ? (filterDateStartInput.value || '').trim() : '';
        const dateEnd = filterDateEndInput ? (filterDateEndInput.value || '').trim() : '';
        const userId = filterUserSelect ? (filterUserSelect.value || '').trim() : '';
        return { dateStart, dateEnd, userId };
    }

    // Popula o select de usuários do filtro do painel
    async function populateDashboardUsersFilter() {
        try {
            if (!filterUserSelect) return;
            const reqId = ++dashboardUsersFilterReqId;
            // Preserva seleção atual
            const prev = filterUserSelect.value;
            const resp = await fetch('/api/users');
            if (!resp.ok) throw new Error('Falha ao carregar usuários');
            const users = await resp.json();
            // Ignora respostas antigas se houver uma chamada mais recente em andamento/concluída
            if (reqId !== dashboardUsersFilterReqId) return;

            // Deduplica por par (email+nome) para evitar duplicatas mesmo com IDs diferentes
            const mapByKey = new Map();
            users.forEach(u => {
                const key = `${String(u.email||'').toLowerCase().trim()}|${String(u.name||'').trim()}`;
                if (!mapByKey.has(key)) mapByKey.set(key, u);
            });
            const uniqueUsers = Array.from(mapByKey.values()).sort((a,b) => String(a.name).localeCompare(String(b.name)));

            // Agora reseta e preenche a lista de forma única
            filterUserSelect.innerHTML = '<option value="">Todos os Usuários</option>';
            uniqueUsers.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.id;
                opt.textContent = `${u.name} (${u.email})`;
                filterUserSelect.appendChild(opt);
            });
            // Restaura seleção se possível
            if (prev && Array.from(filterUserSelect.options).some(o => o.value === prev)) {
                filterUserSelect.value = prev;
            }
        } catch (e) {
            console.warn('Falha ao popular filtro de usuários do painel:', e);
        }
    }

    // Atualiza os contadores e o gráfico do painel principal com filtros opcionais
    async function updateDashboardStats() {
        try {
            const { dateStart, dateEnd, userId } = getDashboardFilters();
            const params = new URLSearchParams();
            if (dateStart) params.set('dateStart', dateStart);
            if (dateEnd) params.set('dateEnd', dateEnd);
            if (userId) params.set('userId', userId);
            const qs = params.toString();
            const url = qs ? `/api/dashboard/stats?${qs}` : '/api/dashboard/stats';
            const response = await fetch(url, { headers: { 'x-session-token': sessionToken } });
            if (!response.ok) throw new Error('Falha ao carregar estatísticas.');
            const stats = await response.json();

            // Atualiza os contadores
            atendimentoCountEl.textContent = stats.attendingCount;
            aguardandoCountEl.textContent = stats.pendingCount;
            finalizadoCountEl.textContent = stats.resolvedTodayCount;

            // Atualiza o gráfico
            if (ticketsChart) {
                ticketsChart.data.datasets[0].data = stats.chartData;
                ticketsChart.update();
            }

        } catch (error) {
            console.error('Erro ao atualizar o painel:', error);
        }
    }

    // Exporta o painel como PDF (usa impressão do navegador)
    function exportDashboardToPDF() {
        try {
            const painel = document.getElementById('painel-content');
            if (!painel) return;

            // Captura imagem do gráfico
            let chartImg = '';
            try {
                const canvas = document.getElementById('ticketsChart');
                chartImg = canvas ? canvas.toDataURL('image/png') : '';
            } catch (_) {}

            const { dateStart, dateEnd, userId } = getDashboardFilters();
            const descDate = (dateStart || dateEnd)
                ? `Período: ${dateStart || '...'} a ${dateEnd || '...'}`
                : 'Período: Hoje';
            const descUser = userId && filterUserSelect && filterUserSelect.selectedIndex >= 0
                ? `Usuário: ${filterUserSelect.options[filterUserSelect.selectedIndex].text}`
                : 'Usuário: Todos';
            const filterDesc = `${descDate} | ${descUser}`;

            const win = window.open('', 'PRINT', 'height=800,width=1000');
            if (!win) return;
            win.document.write(`<!doctype html><html><head><title>Relatório - Painel</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
                <style> body{padding:24px;font-family:Arial;} h2{margin-bottom:4px;} .muted{color:#666} .cards{display:flex;gap:16px;margin:16px 0} .card{flex:1} .chart{margin-top:16px;text-align:center} </style>
            </head><body>`);
            win.document.write(`<h2>Relatório do Painel</h2><div class="muted mb-3">${filterDesc}</div>`);
            win.document.write(`<div class="cards">
                <div class="card border-primary"><div class="card-body"><div class="text-muted">Atendimento</div><div class="fs-3">${atendimentoCountEl.textContent}</div></div></div>
                <div class="card border-warning"><div class="card-body"><div class="text-muted">Aguardando</div><div class="fs-3">${aguardandoCountEl.textContent}</div></div></div>
                <div class="card border-success"><div class="card-body"><div class="text-muted">Finalizado</div><div class="fs-3">${finalizadoCountEl.textContent}</div></div></div>
            </div>`);
            if (chartImg) {
                win.document.write(`<div class="chart"><img id="chart-export-img" src="${chartImg}" style="max-width:100%"></div>`);
            }
            win.document.write(`</body></html>`);
            win.document.close();
            // Aguarda imagem embutida carregar antes de imprimir, para evitar páginas em branco em alguns navegadores
            const maybeImg = win.document.getElementById('chart-export-img');
            const triggerPrint = () => { try { win.focus(); win.print(); } catch (_) {} };
            if (maybeImg && !maybeImg.complete) {
                maybeImg.onload = () => setTimeout(triggerPrint, 50);
                maybeImg.onerror = () => setTimeout(triggerPrint, 50);
            } else {
                setTimeout(triggerPrint, 50);
            }
        } catch (e) {
            console.warn('Falha ao exportar PDF:', e);
        }
    }

    function initializeChart() {
        const ctx = document.getElementById('ticketsChart').getContext('2d');
        ticketsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Manhã', 'Tarde', 'Noite'],
                datasets: [{
                    label: 'Tickets Atendidos',
                    data: [0, 0, 0], // Inicia com dados zerados
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: { scales: { y: { beginAtZero: true } } }
        });
    }

    // Carrega e renderiza os tickets
    async function loadTickets() {
        // Coalesce concurrent calls: se já existe uma chamada em andamento, retornamos a mesma promise.
        if (loadTickets._inFlight) {
            return loadTickets._inFlight;
        }

        loadTickets._inFlight = (async () => {
            console.log('loadTickets called with currentTicketStatus:', currentTicketStatus, 'currentTicketView:', currentTicketView);
            try {
            // Preparar parâmetros de filtro
            let userParams = '';
            // Prioridade: se o agente selecionou filtros específicos (selectedQueueFilters), usa-os.
            let effectiveQueueIds = null;
            if (Array.isArray(selectedQueueFilters) && selectedQueueFilters.length > 0) {
                effectiveQueueIds = selectedQueueFilters;
            } else if (currentUser && currentUser.id && currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                effectiveQueueIds = currentUser.queue_ids.map(v => Number(v));
            }
            if (effectiveQueueIds && effectiveQueueIds.length > 0) {
                userParams = `&user_id=${currentUser.id}&queue_ids=${effectiveQueueIds.join(',')}`;
            }
            
            // Se a visão principal não for 'inbox', busca por ela (ex: 'resolved')
            if (currentTicketView !== 'inbox') {
                if (currentTicketView === 'pending') {
                    let tickets = [];
                    let primaryFetchOk = false;
                    if (supportsOnHoldFilter) {
                        try {
                            const resp = await fetch(`/api/tickets?status=pending&on_hold=1${userParams}`);
                            if (resp.ok) {
                                tickets = await resp.json();
                                primaryFetchOk = true;
                            } else if (resp.status === 500 || resp.status === 400) {
                                supportsOnHoldFilter = false; // Provavelmente backend antigo
                            }
                        } catch (e) {
                            // Falha de rede ou backend antigo
                            supportsOnHoldFilter = false;
                        }
                    }

                    if (!supportsOnHoldFilter) {
                        // Fallback: pegar todos pendentes (backend legado) e tratar todos como "PENDENTE"
                        try {
                            const legacyResp = await fetch(`/api/tickets?status=pending${userParams}`);
                            if (legacyResp.ok) {
                                tickets = await legacyResp.json();
                                // Mostra aviso explicando necessidade de atualização do backend
                                noTicketsMessage.classList.remove('d-none');
                                noTicketsMessage.innerHTML = '<div><h6>Nenhum ticket aqui!</h6></div>';
                            }
                        } catch (e) {
                            console.error('Falha no fallback legacy:', e);
                        }
                    }

                    // Mantém subtabs visíveis mesmo na visão PENDENTE
                    const subTabsContainer = document.getElementById('inbox-subtabs-container');
                    if (subTabsContainer) subTabsContainer.classList.remove('d-none');

                    renderTicketList(tickets);

                    // Se usamos filtro e veio vazio, exibir mensagem específica
                    if (supportsOnHoldFilter && primaryFetchOk && tickets.length === 0) {
                        noTicketsMessage.classList.remove('d-none');
                        noTicketsMessage.innerHTML = '<div><h6>Nenhum ticket aqui!</h6></div>';
                    }
                    return;
                } else {
                    // resolved ou outras futuras
                    const response = await fetch(`/api/tickets?status=${currentTicketView}${userParams}`);
                    if (!response.ok) throw new Error('Falha ao carregar os tickets');
                    const subTabsContainer = document.getElementById('inbox-subtabs-container');
                    if (subTabsContainer) subTabsContainer.classList.remove('d-none');
                    const tickets = await response.json();
                    renderTicketList(tickets);
                    return;
                }
            }
            // Se a visão for 'inbox', busca com base na sub-aba (atendendo/aguardando)
            const url = `/api/tickets?status=${currentTicketStatus}${currentTicketStatus === 'pending' ? (supportsOnHoldFilter ? '&on_hold=0' : '') : ''}${userParams}`;
            console.log('Fetching tickets from:', url);
            const response = await fetch(url);
            if (!response.ok) throw new Error('Falha ao carregar os tickets');
            // Garante que as sub-abas estejam visíveis na caixa de entrada
            const subTabsContainer = document.getElementById('inbox-subtabs-container');
            if (subTabsContainer) subTabsContainer.classList.remove('d-none');
            const tickets = await response.json();

            // Busca a contagem de tickets aguardando para a notificação
                // Busca a contagem de tickets AGUARDANDO (on_hold=0)
                console.log('Tickets received for inbox:', tickets.length);
                const pendingAwaitingResp = await fetch(`/api/tickets?status=pending&on_hold=0${userParams}`);
                const awaitingTickets = await pendingAwaitingResp.json();
                updateNotificationBadge(awaitingTickets.length);

                // Busca a contagem de tickets PENDENTE (on_hold=1) para o badge lateral
                const pendingOnHoldResp = await fetch(`/api/tickets?status=pending&on_hold=1${userParams}`);
                const onHoldTickets = await pendingOnHoldResp.json();
                updatePendingSidebarBadge(onHoldTickets.length);

            renderTicketList(tickets);
            return;
        } catch (error) {
            console.error('Erro ao carregar tickets:', error);
            noTicketsMessage.classList.remove('d-none');
            ticketListContainer.classList.add('d-none');
            throw error;
        } finally {
            // limpa flag permitindo novas invocações
            try { delete loadTickets._inFlight; } catch (e) { loadTickets._inFlight = null; }
        }
        })();

        return loadTickets._inFlight;
    }

    // Função auxiliar para renderizar a lista de tickets
    function renderTicketList(tickets) {
        ticketListContainer.innerHTML = ''; // Limpa a lista
        
        // Filtra tickets concluídos de outros agentes
        const filteredTickets = tickets.filter(ticket => {
            // Se o ticket está concluído e pertence a outro agente, não mostra
            if (ticket.status === 'resolved' && ticket.user_id && ticket.user_id !== currentUser.id) {
                return false;
            }
            return true;
        });
        
        if (filteredTickets.length === 0) {
            noTicketsMessage.classList.remove('d-none');
            ticketListContainer.classList.add('d-none');
        } else {
            noTicketsMessage.classList.add('d-none');
            ticketListContainer.classList.remove('d-none');
            
            // Renderiza todos os tickets filtrados de uma vez e usa o
            // scroll do contêiner (`#ticket-list`) para navegar.
            // Isso remove a paginação numérica e permite busca via scrollbar.
            filteredTickets.forEach(renderTicketItem);

            // Ajusta dinamicamente a altura máxima do contêiner para
            // exibir 6 tickets visíveis e deixar o restante rolável.
            // Calculamos a altura do primeiro item renderizado para
            // suportar variações de padding/linha em diferentes temas.
            requestAnimationFrame(() => {
                try {
                    if (!ticketListContainer) return;
                    const firstItem = ticketListContainer.querySelector('.list-group-item');
                    if (firstItem) {
                        const itemHeight = firstItem.getBoundingClientRect().height;
                        // Segurança: se a altura for zero (não renderizado), não aplicar
                        if (itemHeight > 0) {
                            ticketListContainer.style.maxHeight = (itemHeight * 6) + 'px';
                            ticketListContainer.style.overflowY = 'auto';
                        }
                    } else {
                        // Nenhum item: limpa restrições para mostrar mensagem "nenhum ticket"
                        ticketListContainer.style.maxHeight = '';
                        ticketListContainer.style.overflowY = '';
                    }
                } catch (e) {
                    console.warn('Erro ao ajustar altura do ticket-list:', e);
                }
            });
        }
    }

    // Função para renderizar controles de paginação
    function renderPagination(totalPages) {
        console.log('Rendering pagination with', totalPages, 'pages, current page:', currentPage);
        const paginationContainer = document.createElement('nav');
        paginationContainer.setAttribute('aria-label', 'Paginação de tickets');
        paginationContainer.className = 'mt-3';
        
        const paginationUl = document.createElement('ul');
        paginationUl.className = 'pagination pagination-sm justify-content-center';
        
        // Botão Anterior
        const prevLi = document.createElement('li');
        prevLi.className = `page-item ${currentPage === 1 ? 'disabled' : ''}`;
        const prevA = document.createElement('a');
        prevA.className = 'page-link';
        prevA.href = '#';
        prevA.textContent = 'Anterior';
        prevA.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentPage > 1) {
                currentPage--;
                console.log('Pagination: Going to previous page', currentPage);
                loadTickets(); // Recarrega a lista com a nova página
            }
        });
        prevLi.appendChild(prevA);
        paginationUl.appendChild(prevLi);
        
        // Abas numéricas
        for (let i = 1; i <= totalPages; i++) {
            const pageLi = document.createElement('li');
            pageLi.className = `page-item ${i === currentPage ? 'active' : ''}`;
            const pageA = document.createElement('a');
            pageA.className = 'page-link';
            pageA.href = '#';
            pageA.textContent = i;
            pageA.addEventListener('click', (e) => {
                e.preventDefault();
                currentPage = i;
                console.log('Pagination: Going to page', currentPage);
                loadTickets(); // Recarrega a lista com a nova página
            });
            pageLi.appendChild(pageA);
            paginationUl.appendChild(pageLi);
        }
        
        // Botão Próximo
        const nextLi = document.createElement('li');
        nextLi.className = `page-item ${currentPage === totalPages ? 'disabled' : ''}`;
        const nextA = document.createElement('a');
        nextA.className = 'page-link';
        nextA.href = '#';
        nextA.textContent = 'Próximo';
        nextA.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentPage < totalPages) {
                currentPage++;
                console.log('Pagination: Going to next page', currentPage);
                loadTickets(); // Recarrega a lista com a nova página
            }
        });
        nextLi.appendChild(nextA);
        paginationUl.appendChild(nextLi);
        
        paginationContainer.appendChild(paginationUl);
        ticketListContainer.appendChild(paginationContainer);
    }

    // Renderiza um item na lista de tickets
    function renderTicketItem(ticket) {
        const ticketElement = document.createElement('div');
        const isActive = ticket.id == activeTicketId ? 'active' : '';
        // Adiciona position-relative para o posicionamento absoluto do overlay
        ticketElement.className = `list-group-item list-group-item-action p-2 border-bottom ${isActive} position-relative`;
        ticketElement.setAttribute('data-ticket-id', ticket.id);
    ticketElement.setAttribute('data-status', ticket.status);
    ticketElement.setAttribute('data-profile-pic-url', ticket.profile_pic_url || '');
    ticketElement.setAttribute('data-protocol-number', ticket.protocol_number || '');
    // Exponha metadados úteis para handlers (connection_id, is_on_hold, user_id, queue_id)
    ticketElement.setAttribute('data-connection-id', ticket.connection_id === null || typeof ticket.connection_id === 'undefined' ? '' : ticket.connection_id);
    ticketElement.setAttribute('data-is-on-hold', typeof ticket.is_on_hold === 'undefined' || ticket.is_on_hold === null ? '' : String(ticket.is_on_hold));
    ticketElement.setAttribute('data-ticket-user-id', typeof ticket.user_id === 'undefined' || ticket.user_id === null ? '' : String(ticket.user_id));
    ticketElement.setAttribute('data-queue-id', typeof ticket.queue_id === 'undefined' || ticket.queue_id === null ? '' : String(ticket.queue_id));
        ticketElement.style.cursor = 'pointer';

        // A data vem do banco já no formato correto para o sistema local
        const lastMessageDate = new Date(ticket.last_message_at);
        const timeString = lastMessageDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dateString = lastMessageDate.toLocaleDateString('pt-BR');
        const dateTimeString = `${dateString} ${timeString}`;

        // Usa a formatação do servidor se disponível, senão usa a formatação local
        const displayTime = ticket.formatted_last_message_time || dateTimeString;

    // Define a classe/ cor da barra de status com base na visão/aba atual e na queue
    const effectiveStatus = (currentTicketView === 'pending') ? 'pending' : currentTicketStatus;
    // Determina cor da fila (se houver)
    let stripeColor = null;
    try {
        // tickets criados manualmente (sem connection_id) devem ser cinza
        if (ticket.connection_id === null || typeof ticket.connection_id === 'undefined') {
            stripeColor = '#6c757d'; // cinza bootstrap
        } else if (ticket.queue_id && queueColorMap && queueColorMap[String(ticket.queue_id)]) {
            stripeColor = queueColorMap[String(ticket.queue_id)];
        }
    } catch (e) { /* ignore */ }
    // Fallbacks: se não há cor de fila definida, usamos verde para attending e amarelo para pending
    if (!stripeColor) {
        stripeColor = (effectiveStatus === 'attending') ? '#198754' : '#ffc107';
    }

        // Conteúdo principal do ticket
        let ticketHTML = '';
        // Não mostra botão aceitar para tickets concluídos
        if (ticket.status === 'resolved') {
            ticketHTML = `
                <div class="ticket-info-content">
                    <div class="d-flex w-100 justify-content-between">
                        <h6 class="mb-1 text-truncate">${ticket.contact_name}</h6>
                        <small class="text-muted">${displayTime}</small>
                    </div>
                    ${ticket.protocol_number ? `<p class="mb-0 small text-primary position-relative d-inline-block"><i class="bi bi-file-earmark-text me-1"></i><strong>Protocolo:</strong> ${ticket.protocol_number}${ticket.unread_messages > 0 ? `<span class="badge bg-success rounded-pill position-absolute top-0 start-100 translate-middle ms-1" style="font-size: 0.65rem;">${ticket.unread_messages}</span>` : ''}</p>` : ''}
                    <p class="mb-1 small text-muted text-truncate">${ticket.last_message}</p>
                </div>
                <!-- Barra de Status Colorida -->
                <div class="ticket-status-bar" style="background-color: ${stripeColor};"></div>
            `;
        } else if (effectiveStatus === 'pending' && (ticket.is_on_hold === 0 || ticket.is_on_hold === null || ticket.is_on_hold === undefined)) {
            // Botão Aceitar flutuando centralizado no topo do ticket, badge ao lado
            ticketHTML = `
                <div class="ticket-info-content position-relative">
                    <div class="d-flex w-100 justify-content-between align-items-center">
                        <h6 class="mb-1 text-truncate">${ticket.contact_name}</h6>
                        <small class="text-muted">${displayTime}</small>
                    </div>
                    ${ticket.protocol_number ? `<p class="mb-0 small text-primary position-relative d-inline-block"><i class="bi bi-file-earmark-text me-1"></i><strong>Protocolo:</strong> ${ticket.protocol_number}${ticket.unread_messages > 0 ? `<span class="badge bg-success rounded-pill position-absolute top-0 start-100 translate-middle ms-1" style="font-size: 0.65rem;">${ticket.unread_messages}</span>` : ''}</p>` : ''}
                    <p class="mb-1 small text-muted text-truncate">${ticket.last_message}</p>
                    <div class="position-absolute top-0 start-50 translate-middle-x mt-2 d-flex align-items-center" style="z-index:2;">
                        <button class="btn btn-sm btn-primary accept-ticket-btn" title="Aceitar atendimento">Aceitar</button>
                    </div>
                </div>
                <!-- Barra de Status Colorida -->
                <div class="ticket-status-bar" style="background-color: ${stripeColor};"></div>
            `;
        } else {
            ticketHTML = `
                <div class="ticket-info-content">
                    <div class="d-flex w-100 justify-content-between">
                        <h6 class="mb-1 text-truncate">${ticket.contact_name}</h6>
                        <small class="text-muted">${displayTime}</small>
                    </div>
                    ${ticket.protocol_number ? `<p class="mb-0 small text-primary position-relative d-inline-block"><i class="bi bi-file-earmark-text me-1"></i><strong>Protocolo:</strong> ${ticket.protocol_number}${ticket.unread_messages > 0 ? `<span class="badge bg-success rounded-pill position-absolute top-0 start-100 translate-middle ms-1" style="font-size: 0.65rem;">${ticket.unread_messages}</span>` : ''}</p>` : ''}
                    <p class="mb-1 small text-muted text-truncate">${ticket.last_message}</p>
                </div>
                <!-- Barra de Status Colorida -->
                <div class="ticket-status-bar" style="background-color: ${stripeColor};"></div>
            `;
        }
        ticketElement.innerHTML = ticketHTML;
        ticketListContainer.appendChild(ticketElement);
    }

    // (Painel de debug PENDENTE removido conforme solicitação do usuário)

    // Atualiza o badge de notificação
    function updateNotificationBadge(count) {
        if (count > 0) {
            notificationAguardando.textContent = count;
            notificationAguardando.classList.remove('d-none');
        } else {
            notificationAguardando.classList.add('d-none');
        }
    }

    // Atualiza o badge da aba lateral PENDENTE
    function updatePendingSidebarBadge(count) {
        const pendingBadge = document.getElementById('notification-pendente');
        if (!pendingBadge) return;
        if (count > 0) {
            pendingBadge.textContent = count;
            pendingBadge.classList.remove('d-none');
        } else {
            pendingBadge.classList.add('d-none');
        }
    }

    // Função unificada para atualizar rapidamente todos os indicadores/badges e contadores do painel
    async function refreshTicketIndicators() {
        try {
            // Preparar parâmetros de filtro
            let userParams = '';
            if (currentUser && currentUser.id && currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                userParams = `&user_id=${currentUser.id}&queue_ids=${currentUser.queue_ids.join(',')}`;
            }
            
            const ts = Date.now(); // evita cache
            const [awaitingResp, onHoldResp, attendingResp] = await Promise.all([
                fetch(`/api/tickets?status=pending&on_hold=0${userParams}&_=${ts}`),
                fetch(`/api/tickets?status=pending&on_hold=1${userParams}&_=${ts}`),
                fetch(`/api/tickets?status=attending${userParams}&_=${ts}`)
            ]);
            if (awaitingResp.ok) {
                const awaitingTickets = await awaitingResp.json();
                updateNotificationBadge(awaitingTickets.length);
            }
            if (onHoldResp.ok) {
                const onHoldTickets = await onHoldResp.json();
                updatePendingSidebarBadge(onHoldTickets.length);
            }
            // Atualiza também os counters do painel principal
            updateDashboardStats();
        } catch (e) {
            console.warn('Falha ao atualizar indicadores de tickets', e);
        }
    }


    // Move um ticket para o status de 'atendendo'
    async function attendTicket(ticketId) {
        try {
            console.log('DEBUG attendTicket - currentUser:', currentUser);
            
            // Preparar dados para enviar
            const updateData = { status: 'attending' };
            
            // Se tiver usuário logado, adiciona user_id e queue_id
            if (currentUser && currentUser.id) {
                updateData.user_id = currentUser.id;
                // Se o usuário tiver filas, usa a primeira
                if (currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                    updateData.queue_id = currentUser.queue_ids[0];
                }
            }
            
            console.log('DEBUG attendTicket - updateData:', updateData);
            
            const response = await fetch(`/api/tickets/${ticketId}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });
            if (!response.ok) {
                const errorData = await response.json();
                console.error('DEBUG attendTicket - error response:', errorData);
                throw new Error(errorData.error || 'Falha ao mover o ticket.');
            }
            await refreshTicketIndicators();
            persistState();
            // A UI será atualizada pelo evento do WebSocket
        } catch (error) {
            console.error('Erro ao atender ticket:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Resolve um ticket
    async function resolveTicket() {
        if (!activeTicketId) return;

        try {
            const response = await fetch(`/api/tickets/${activeTicketId}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'resolved' })
            });
            if (!response.ok) {
                throw new Error('Falha ao resolver o ticket.');
            }
            showNotification('Ticket resolvido com sucesso!', 'success');
            // Esconde a área de chat e mostra a mensagem de boas-vindas
            chatArea.classList.add('d-none');
            chatWelcomeMessage.classList.remove('d-none');
            activeTicketId = null;
            await refreshTicketIndicators();
            persistState();
            // A notificação do WebSocket já chama updateDashboardStats(), mas podemos forçar aqui para garantir.
        } catch (error) {
            console.error('Erro ao resolver ticket:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Reabre um ticket
// Reabre um ticket — CORRIGIDO: força a VIEW 'pending' e atualiza badges/listas
async function reopenTicket() {
    if (!activeTicketId) {
        showNotification('Nenhum ticket selecionado para marcar como pendente.', 'warning');
        return;
    }

    try {
        const response = await fetch(`/api/tickets/${activeTicketId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'pending', on_hold: true })
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.error || errBody.message || 'Falha ao reabrir o ticket.');
        }

        await refreshTicketIndicators();
    persistState();
        showNotification('Ticket marcado como PENDENTE e movido para a Lista PENDENTE.', 'success');

        // Esconde a área de chat e reseta o ticket ativo
        chatArea.classList.add('d-none');
        chatWelcomeMessage.classList.remove('d-none');
        activeTicketId = null;

        // Não navega automaticamente para a lista PENDENTE; apenas atualiza indicadores
        await loadTickets();
    } catch (error) {
        console.error('Erro ao reabrir ticket:', error);
        showNotification(`Erro: ${error.message}`, 'danger');
    }
}

    // Exclui um ticket permanentemente
    function openDeleteTicketModal(ticketId) {
        if (!ticketId) return;
        // Armazena o ID do ticket a ser excluído
        ticketIdToDelete = ticketId;
        deleteTicketModal.show();
    }
    async function confirmDeleteTicket() {
        if (!ticketIdToDelete) return;
        try {
            const response = await fetch(`/api/tickets/${ticketIdToDelete}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error('Falha ao excluir o ticket.');
            }
            showNotification('Ticket excluído com sucesso!', 'success');
            deleteTicketModal.hide();
            chatArea.classList.add('d-none');
            chatWelcomeMessage.classList.remove('d-none');
            if (activeTicketId === ticketIdToDelete) {
                activeTicketId = null;
            }
            loadTickets(); // Recarrega a lista de tickets para remover o item excluído
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        } finally {
            ticketIdToDelete = null; // Limpa o ID após a operação
        }
    }

    // Abre o modal de transferência de ticket
    async function openTransferTicketModal(ticketId) {
        if (!ticketId) return;

        try {
            const response = await fetch('/api/queues');
            if (!response.ok) throw new Error('Falha ao carregar filas para transferência.');
            const queues = await response.json();

            const queueSelect = document.getElementById('transfer-queue-select');
            const userSelect = document.getElementById('transfer-user-select');
            
            queueSelect.innerHTML = '<option value="">Selecione uma fila...</option>';
            userSelect.innerHTML = '<option value="">Selecione um atendente (opcional)...</option>';
            
            queues.forEach(queue => {
                const option = new Option(queue.name, queue.id);
                queueSelect.add(option);
            });

            // Listener para carregar atendentes quando a fila for selecionada
            queueSelect.onchange = async function() {
                const selectedQueueId = this.value;
                userSelect.innerHTML = '<option value="">Selecione um atendente (opcional)...</option>';
                
                if (selectedQueueId) {
                    try {
                        const usersResponse = await fetch(`/api/queues/${selectedQueueId}/users`);
                        if (usersResponse.ok) {
                            const users = await usersResponse.json();
                            users.forEach(user => {
                                const option = new Option(user.name, user.id);
                                userSelect.add(option);
                            });
                        }
                    } catch (error) {
                        console.error('Erro ao carregar atendentes:', error);
                    }
                }
            };

            transferTicketModal.show();
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Confirma a transferência do ticket a partir do modal
    async function confirmTransferTicket() {
        const queueId = document.getElementById('transfer-queue-select').value;
        const userId = document.getElementById('transfer-user-select').value; // Opcional
        const transferHistory = document.querySelector('input[name="transferHistory"]:checked').value;

    if (!queueId) { showNotification('Por favor, selecione uma fila de destino.', 'warning'); return; }

        transferTicket(activeTicketId, queueId, userId, transferHistory);
    }
    // Função que efetivamente transfere o ticket
    async function transferTicket(ticketId, queueId, userId, transferHistory = 'yes') {
        try {
            const response = await fetch(`/api/tickets/${ticketId}/transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queueId, userId, transferHistory, sessionToken: sessionToken })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao transferir o ticket.');
            }

            const result = await response.json();
            
            if (transferHistory === 'no' && result.newTicketId) {
                showNotification(`Ticket atual resolvido. Novo ticket criado com protocolo: ${result.newProtocol}`, 'success');
            } else {
                showNotification('Ticket transferido com sucesso!', 'success');
            }
            
            transferTicketModal.hide();

            // Limpa a área de chat e recarrega a lista de tickets
            chatArea.classList.add('d-none');
            chatWelcomeMessage.classList.remove('d-none');
            activeTicketId = null;
            // Recarrega tickets e estatísticas para atualizar contadores imediatamente
            await loadTickets();
            updateDashboardStats();
            // Atualiza badges aguardando / pendente explicitamente (caso a transferência mude fila sem disparar evento WS de status)
            try {
                const awaitingResp = await fetch(`/api/tickets?status=pending&on_hold=0${buildUserParams()}`);
                if (awaitingResp.ok) {
                    const awaitingTickets = await awaitingResp.json();
                    updateNotificationBadge(awaitingTickets.length);
                }
                const onHoldResp = await fetch(`/api/tickets?status=pending&on_hold=1${buildUserParams()}`);
                if (onHoldResp.ok) {
                    const onHoldTickets = await onHoldResp.json();
                    updatePendingSidebarBadge(onHoldTickets.length);
                }
            } catch(e) { console.warn('Falha atualização rápida de badges pós-transferência', e); }
            persistState();

        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Atualiza apenas a janela de chat com novas mensagens
    async function refreshActiveChat() {
        if (!activeTicketId) return;

        try {
            const messagesResponse = await fetch(`/api/tickets/${activeTicketId}/messages`, { headers: { 'x-session-token': sessionToken } });
            if (!messagesResponse.ok) throw new Error('Falha ao recarregar mensagens.');
            const messages = await messagesResponse.json();

            // Busca os dados do ticket para verificar o status
            let ticketDetails = null;
            try {
                const ticketDetailResponse = await fetch(`/api/tickets?status=pending&user_id=${currentUser.id}`, { headers: { 'x-session-token': sessionToken } });
                if (ticketDetailResponse.ok) {
                    const pendingTickets = await ticketDetailResponse.json();
                    ticketDetails = pendingTickets.find(t => t.id === activeTicketId);
                }
            } catch (e) {
                // Ignora erro silenciosamente e continua
            }

            if (!ticketDetails) {
                try {
                    const ticketDetailResponse = await fetch(`/api/tickets?status=attending&user_id=${currentUser.id}`, { headers: { 'x-session-token': sessionToken } });
                    if (ticketDetailResponse.ok) {
                        const attendingTickets = await ticketDetailResponse.json();
                        ticketDetails = attendingTickets.find(t => t.id === activeTicketId);
                    }
                } catch (e) {
                    // Ignora erro silenciosamente e continua
                }
            }

            if (!ticketDetails) {
                try {
                    const ticketDetailResponse = await fetch(`/api/tickets?status=resolved${buildUserParams()}`, { headers: { 'x-session-token': sessionToken } });
                    if (ticketDetailResponse.ok) {
                        const resolvedTickets = await ticketDetailResponse.json();
                        ticketDetails = resolvedTickets.find(t => t.id === activeTicketId);
                    }
                } catch (e) {
                    // Ignora erro silenciosamente e continua
                }
            }

            // Renderiza as novas mensagens
            chatBody.innerHTML = '';
            messages.forEach(renderMessage);

            // Rola para a última mensagem
            chatBody.scrollTop = chatBody.scrollHeight;

            // Reaplica a lógica de desabilitar controles se o ticket estiver resolvido ou pendente
            const chatInputDisabled = ticketDetails && (
                (ticketDetails.status === 'pending' && ticketDetails.is_on_hold === 1) || 
                ticketDetails.status === 'resolved'
            );
            if (chatInputDisabled) {
                chatMessageInput.disabled = true;
                if (ticketDetails.status === 'resolved') {
                    chatMessageInput.placeholder = 'Ticket concluído - sem interação permitida';
                } else {
                    chatMessageInput.placeholder = 'Clique em "Continuar Atendimento" para enviar mensagens';
                }
                const sendButton = chatForm.querySelector('button[type="submit"]');
                if (sendButton) sendButton.disabled = true;
                const recordButton = document.getElementById('record-audio-button');
                if (recordButton) recordButton.disabled = true;
                const attachButton = document.getElementById('attach-file-button');
                if (attachButton) attachButton.disabled = true;
                const emojiButton = document.getElementById('emoji-button');
                if (emojiButton) emojiButton.disabled = true;
            } else {
                chatMessageInput.disabled = false;
                chatMessageInput.placeholder = 'Digite sua mensagem...';
                const sendButton = chatForm.querySelector('button[type="submit"]');
                if (sendButton) sendButton.disabled = false;
                const recordButton = document.getElementById('record-audio-button');
                if (recordButton) recordButton.disabled = false;
                const attachButton = document.getElementById('attach-file-button');
                if (attachButton) attachButton.disabled = false;
                const emojiButton = document.getElementById('emoji-button');
                if (emojiButton) emojiButton.disabled = false;
            }

            // Atualiza a lista da esquerda para refletir a última mensagem, sem recarregar tudo
            loadTickets();

        } catch (error) {
            console.error('Erro ao recarregar chat:', error);
        }
    }

    // Carrega a conversa de um ticket específico
    async function loadChat(ticketId) {
        console.log('[LOAD-CHAT] start loadChat for ticketId=', ticketId, 'currentUser=', currentUser && currentUser.id);
        // Define o ticket ativo ANTES de qualquer outra coisa
        activeTicketId = ticketId;
        persistState();
        
        // Limpa o campo de mensagem ao trocar de ticket
        if (chatMessageInput) {
            chatMessageInput.value = '';
        }
        
        // Limpa notificações relacionadas a este ticket (se houver)
        try { clearNotificationsForTicket(ticketId); } catch(e) { console.warn('Erro ao limpar notificações ao abrir chat', e); }
        
        // Zera o badge de mensagens não lidas do ticket na lista
        try {
            const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${ticketId}']`);
            if (ticketEl) {
                const badgeEl = ticketEl.querySelector('.badge.bg-success.rounded-pill');
                if (badgeEl) {
                    badgeEl.remove();
                }
            }
        } catch(e) { console.warn('Erro ao remover badge do ticket ao abrir chat', e); }

        try {
            // Busca dados do ticket (para saber status e is_on_hold)
            let ticketDetails = null;
            try {
                // Tenta buscar em pending primeiro (filtrando pelo agente atual)
                const tResp = await fetch(`/api/tickets?status=pending${buildUserParams()}`);
                console.log('[LOAD-CHAT] fetch pending tickets status=', tResp.status);
                if (tResp.ok) {
                    const allPending = await tResp.json();
                    ticketDetails = allPending.find(t => t.id == ticketId);
                }
                // Se não encontrou, tenta em attending
                if (!ticketDetails) {
                    const attendingResp = await fetch(`/api/tickets?status=attending${buildUserParams()}`);
                    if (attendingResp.ok) {
                        const allAtt = await attendingResp.json();
                        ticketDetails = allAtt.find(t => t.id == ticketId);
                    }
                }
                // Se ainda não encontrou, tenta em resolved
                if (!ticketDetails) {
                    const resolvedResp = await fetch(`/api/tickets?status=resolved${buildUserParams()}`);
                    console.log('[LOAD-CHAT] fetch resolved tickets status=', resolvedResp.status);
                    if (resolvedResp.ok) {
                        const allResolved = await resolvedResp.json();
                        ticketDetails = allResolved.find(t => t.id == ticketId);
                    }
                }
            } catch (e) { console.warn('Erro ao buscar detalhes do ticket:', e); }

            // Bloqueia abertura de tickets concluídos (exceto para Admin)
            if (ticketDetails && ticketDetails.status === 'resolved') {
                // Verifica se é Admin
                const isAdmin = currentUser && (String(currentUser.profile).toLowerCase() === 'admin' || String(currentUser.profile).toLowerCase() === 'administrador');
                
                // Admin tem acesso a todos os tickets
                if (!isAdmin && ticketDetails.user_id && ticketDetails.user_id !== currentUser.id) {
                    // Outro agente concluiu - acesso negado
                    chatBody.innerHTML = `
                        <div class="alert alert-warning text-center mt-5">
                            <i class="bi bi-shield-lock fs-1"></i>
                            <h5 class="mt-3">Acesso Restrito</h5>
                            <p>Este ticket foi concluído por outro agente.</p>
                            <p>Você não tem permissão para visualizar o histórico.</p>
                        </div>
                    `;
                    
                    // Limpa informações do chat
                    chatContactName.textContent = 'Acesso Restrito';
                    chatProfilePic.src = 'https://via.placeholder.com/40';
                    const chatProtocolElement = document.getElementById('chat-protocol-number');
                    if (chatProtocolElement) chatProtocolElement.classList.add('d-none');
                    
                    hideChatPlaceholder();
                    
                    // Desabilita tudo
                    chatMessageInput.disabled = true;
                    const chatSubmitButton = chatForm.querySelector('button[type="submit"]');
                    if (chatSubmitButton) chatSubmitButton.disabled = true;
                    const attachButton = document.getElementById('attach-file-button');
                    if (attachButton) attachButton.disabled = true;
                    const recordButton = document.getElementById('record-audio-button');
                    if (recordButton) recordButton.disabled = true;
                    const emojiButton = document.getElementById('emoji-button');
                    if (emojiButton) emojiButton.disabled = true;
                    
                    // Esconde todos os botões de ação
                    resolveTicketButton.classList.add('d-none');
                    if (reopenTicketButton) reopenTicketButton.classList.add('d-none');
                    transferTicketButton.classList.add('d-none');
                    deleteTicketButton.classList.add('d-none');
                    const continueBtn = document.getElementById('continuar-ticket-button');
                    if (continueBtn) continueBtn.classList.add('d-none');
                    
                    return;
                }
                
                // Agente que concluiu pode visualizar
                // Carrega as mensagens primeiro
                const messagesResponse = await fetch(`/api/tickets/${ticketId}/messages?userId=${currentUser.id}`);
                if (messagesResponse.ok) {
                    const messages = await messagesResponse.json();
                    
                    // Busca o nome do contato
                    const ticketItem = ticketListContainer.querySelector(`[data-ticket-id='${ticketId}']`);
                    const contactName = ticketItem ? ticketItem.querySelector('h6').textContent : 'Contato';
                    const profilePicUrl = ticketItem ? ticketItem.getAttribute('data-profile-pic-url') : '';
                    const protocolNumber = ticketItem ? ticketItem.getAttribute('data-protocol-number') : '';

                    // Atualiza a UI
                    chatContactName.textContent = contactName;
                    chatProfilePic.src = profilePicUrl || 'https://via.placeholder.com/40';
                    
                    // Exibe o número de protocolo se disponível
                    const chatProtocolElement = document.getElementById('chat-protocol-number');
                    const protocolValueElement = document.getElementById('protocol-value');
                    if (protocolNumber && chatProtocolElement && protocolValueElement) {
                        // Monta sufixo com o nome do agente (se disponível)
                        let agentSuffix = '';
                        try {
                            let agentName = (currentTicketAgentInfo && currentTicketAgentInfo.agentName) ? currentTicketAgentInfo.agentName : '';
                            if (!agentName && ticketDetails && ticketDetails.user_id) {
                                const uResp = await fetch(`/api/users/${ticketDetails.user_id}`);
                                if (uResp.ok) {
                                    const u = await uResp.json();
                                    agentName = u && u.name ? u.name : '';
                                }
                            }
                            if (agentName) agentSuffix = ` / Agente: ${agentName}`;
                        } catch (e) { /* ignore */ }
                        protocolValueElement.textContent = `${protocolNumber}${agentSuffix}`;
                        chatProtocolElement.classList.remove('d-none');
                    } else if (chatProtocolElement) {
                        chatProtocolElement.classList.add('d-none');
                    }
                    
                    hideChatPlaceholder();
                    
                    // Renderiza as mensagens
                    chatBody.innerHTML = '';
                    messages.forEach(renderMessage);
                    chatBody.scrollTop = chatBody.scrollHeight;
                }
                
                // Desabilita o campo de entrada (somente visualização)
                chatMessageInput.disabled = true;
                chatMessageInput.placeholder = 'Este ticket foi concluído - somente visualização';
                const chatSubmitButton = chatForm.querySelector('button[type="submit"]');
                if (chatSubmitButton) chatSubmitButton.disabled = true;
                const attachButton = document.getElementById('attach-file-button');
                if (attachButton) attachButton.disabled = true;
                const recordButton = document.getElementById('record-audio-button');
                if (recordButton) recordButton.disabled = true;
                const emojiButton = document.getElementById('emoji-button');
                if (emojiButton) emojiButton.disabled = true;
                
                // Esconde todos os botões de ação
                resolveTicketButton.classList.add('d-none');
                if (reopenTicketButton) reopenTicketButton.classList.add('d-none');
                transferTicketButton.classList.add('d-none');
                const continueBtn = document.getElementById('continuar-ticket-button');
                if (continueBtn) continueBtn.classList.add('d-none');
                
                // Mantém apenas o botão deletar visível (se tiver permissão)
                if (permissionsManager.canDeleteTickets()) {
                    deleteTicketButton.classList.remove('d-none');
                }
                
                return;
            }

            // Busca informações do agente e departamento: se o ticket está sendo atendido pelo usuário logado, usa localStorage
            currentTicketAgentInfo = null;
            if (
                ticketDetails && ticketDetails.user_id && currentUser && ticketDetails.user_id == currentUser.id
            ) {
                // Usa o nome do usuário logado e a primeira fila dele
                let departmentName = 'Sem departamento';
                if (currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                    // Busca o nome da fila pelo id
                    try {
                        const queueResp = await fetch(`/api/queues/${currentUser.queue_ids[0]}`);
                        if (queueResp.ok) {
                            const queueData = await queueResp.json();
                            departmentName = queueData.name;
                        }
                    } catch (e) { /* ignora erro */ }
                }
                currentTicketAgentInfo = {
                    agentName: currentUser.name,
                    departmentName
                };
            } else if (ticketDetails && ticketDetails.user_id) {
                // Busca do backend (outro agente)
                try {
                    const [userResp, queueResp] = await Promise.all([
                        fetch(`/api/users/${ticketDetails.user_id}`),
                        ticketDetails.queue_id ? fetch(`/api/queues/${ticketDetails.queue_id}`) : Promise.resolve(null)
                    ]);
                    const agentData = userResp.ok ? await userResp.json() : null;
                    const queueData = queueResp && queueResp.ok ? await queueResp.json() : null;
                    if (agentData) {
                        currentTicketAgentInfo = {
                            agentName: agentData.name,
                            departmentName: queueData ? queueData.name : 'Sem departamento'
                        };
                    }
                } catch (e) {
                    console.warn('Erro ao buscar informações do agente/departamento:', e);
                }
            }

            // Busca as mensagens com verificação de permissão
            const messagesResponse = await fetch(`/api/tickets/${ticketId}/messages?userId=${currentUser.id}`);
            console.log('[LOAD-CHAT] GET messages status=', messagesResponse.status);
            if (!messagesResponse.ok) {
                if (messagesResponse.status === 403) {
                    // Sem permissão para acessar o histórico
                    chatBody.innerHTML = `
                        <div class="alert alert-warning text-center mt-5">
                            <i class="bi bi-shield-lock fs-1"></i>
                            <h5 class="mt-3">Acesso Restrito</h5>
                            <p>Você não tem permissão para visualizar o histórico deste ticket.</p>
                            <p>Ticket sendo atendido por: <strong>${ticketDetails && ticketDetails.user_id ? 'Outro Agente' : 'Desconhecido'}</strong></p>
                        </div>
                    `;
                    return;
                }
                throw new Error('Falha ao carregar mensagens.');
            }
            const messages = await messagesResponse.json();

            // Busca o nome do contato (do próprio item do ticket na lista)
            const ticketItem = ticketListContainer.querySelector(`[data-ticket-id='${ticketId}']`);
            const contactName = ticketItem ? ticketItem.querySelector('h6').textContent : 'Contato';
            const profilePicUrl = ticketItem ? ticketItem.getAttribute('data-profile-pic-url') : '';
            const protocolNumber = ticketItem ? ticketItem.getAttribute('data-protocol-number') : '';

            // Atualiza a UI
            chatContactName.textContent = contactName;
            chatProfilePic.src = profilePicUrl || 'https://via.placeholder.com/40'; // Usa a foto ou um placeholder
            
            // Exibe o número de protocolo se disponível
            const chatProtocolElement = document.getElementById('chat-protocol-number');
            const protocolValueElement = document.getElementById('protocol-value');
            if (protocolNumber && chatProtocolElement && protocolValueElement) {
                // Monta sufixo com o nome do agente (se disponível)
                let agentSuffix = '';
                try {
                    const agentName = (currentTicketAgentInfo && currentTicketAgentInfo.agentName) ? currentTicketAgentInfo.agentName : '';
                    if (agentName) agentSuffix = ` / Agente: ${agentName}`;
                } catch (e) { /* ignore */ }
                protocolValueElement.textContent = `${protocolNumber}${agentSuffix}`;
                chatProtocolElement.classList.remove('d-none');
            } else if (chatProtocolElement) {
                chatProtocolElement.classList.add('d-none');
            }
            
            hideChatPlaceholder();

            // Controla a visibilidade dos botões de ação do chat
            const continueBtn = document.getElementById('continuar-ticket-button');
            // Estado inicial: esconder botão continuar
            if (continueBtn) continueBtn.classList.add('d-none');
            
            // Verifica se o ticket está resolvido (tanto pela view quanto pelo status do ticketDetails)
            const isResolvedTicket = currentTicketView === 'resolved' || (ticketDetails && ticketDetails.status === 'resolved');
            
            if (isResolvedTicket) {
                // Em tickets concluídos nunca mostramos os botões de ação, exceto deletar (se tiver permissão)
                resolveTicketButton.classList.add('d-none');
                if (reopenTicketButton) reopenTicketButton.classList.add('d-none');
                transferTicketButton.classList.add('d-none');
                if (permissionsManager.canDeleteTickets()) {
                    deleteTicketButton.classList.remove('d-none');
                }
            } else {
                resolveTicketButton.classList.remove('d-none');
                transferTicketButton.classList.remove('d-none');
                if (permissionsManager.canDeleteTickets()) {
                    deleteTicketButton.classList.remove('d-none');
                }
                if (ticketDetails) {
                    if (ticketDetails.status === 'resolved') {
                        // Nunca mostrar Continuar Atendimento em tickets resolvidos
                        if (continueBtn) continueBtn.classList.add('d-none');
                        resolveTicketButton.classList.add('d-none');
                        if (reopenTicketButton) reopenTicketButton.classList.add('d-none');
                    } else if (ticketDetails.status === 'pending' && ticketDetails.is_on_hold === 1) {
                        // Ticket está em PENDENTE -> mostrar Continuar Atendimento, esconder botão Pendente
                        if (continueBtn) continueBtn.classList.remove('d-none');
                        reopenTicketButton.classList.add('d-none');
                    } else if (ticketDetails.status === 'pending') {
                        // AGUARDANDO
                        if (continueBtn) continueBtn.classList.add('d-none');
                        reopenTicketButton.classList.remove('d-none');
                    } else if (ticketDetails.status === 'attending') {
                        // Em atendimento: ambos (resolver e pendente) visíveis
                        if (continueBtn) continueBtn.classList.add('d-none');
                        reopenTicketButton.classList.remove('d-none');
                    }
                } else {
                    // Fallback se não conseguimos ticketDetails: não exibe pendente para evitar ação indevida
                    if (reopenTicketButton) reopenTicketButton.classList.add('d-none');
                }
            }

            // Renderiza as mensagens
            chatBody.innerHTML = '';
            messages.forEach(renderMessage);

            // Rola para a última mensagem
            chatBody.scrollTop = chatBody.scrollHeight;

            // Controla o campo de mensagem e botões de ação conforme o status do ticket
            const chatInputDisabled = ticketDetails && (
                (ticketDetails.status === 'pending' && ticketDetails.is_on_hold === 1) || 
                ticketDetails.status === 'resolved'
            );
            if (chatInputDisabled) {
                // Desabilita o campo de mensagem e botões quando ticket está PENDENTE ou CONCLUÍDO
                chatMessageInput.disabled = true;
                if (ticketDetails.status === 'resolved') {
                    chatMessageInput.placeholder = 'Ticket concluído - sem interação permitida';
                } else {
                    chatMessageInput.placeholder = 'Clique em "Continuar Atendimento" para enviar mensagens';
                }
                const sendButton = chatForm.querySelector('button[type="submit"]');
                if (sendButton) sendButton.disabled = true;
                const recordButton = document.getElementById('record-audio-button');
                if (recordButton) recordButton.disabled = true;
                const attachButton = document.getElementById('attach-file-button');
                if (attachButton) attachButton.disabled = true;
                const emojiButton = document.getElementById('emoji-button');
                if (emojiButton) emojiButton.disabled = true;
            } else {
                // Habilita o campo de mensagem e botões quando ticket não está PENDENTE
                chatMessageInput.disabled = false;
                chatMessageInput.placeholder = 'Digite sua mensagem...';
                const sendButton = chatForm.querySelector('button[type="submit"]');
                if (sendButton) sendButton.disabled = false;
                const recordButton = document.getElementById('record-audio-button');
                if (recordButton) recordButton.disabled = false;
                const attachButton = document.getElementById('attach-file-button');
                if (attachButton) attachButton.disabled = false;
                const emojiButton = document.getElementById('emoji-button');
                if (emojiButton) emojiButton.disabled = false;
            }

            // Agora que o chat está carregado e o ID ativo está definido, atualiza a lista
            loadTickets(); // Chama para garantir que o item ativo seja destacado
        } catch (error) {
            console.error('Erro ao carregar chat:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Renderiza uma única mensagem no chat
    function renderMessage(message) {
        const isBot = message.sender === 'bot' || message.sender === 'user';
    const messageDiv = document.createElement('div');
    messageDiv.className = `d-flex justify-content-${isBot ? 'end' : 'start'} mb-2`;
    // marca o elemento com o id da mensagem para facilitar atualizações via websocket
    try { if (message && typeof message.id !== 'undefined') messageDiv.setAttribute('data-message-id', message.id); } catch (e) { }

        // Adiciona uma classe específica para estilizar a bolha de chat
        const messageBubbleClass = isBot ? 'message-bot' : 'message-contact';

        // Informações do agente (apenas para mensagens do bot/agente)
        let agentInfoHtml = '';
        if (isBot && message.user_name) {
            // Exibe o nome do usuário (já vem formatado com departamento do servidor)
            agentInfoHtml = `
                <div class="mb-1">
                    <small style="color: #000; font-weight: 500;">
                        ${message.user_name}
                    </small>
                </div>
            `;
        }

        // Renderização com card para todas as mensagens
        messageDiv.innerHTML = `
            <div class="card ${messageBubbleClass}" style="max-width: 75%;">
                <div class="card-body p-2">
                    ${agentInfoHtml}
                    <p class="card-text small ${message.body.startsWith('[Arquivo:') ? 'mb-0 mt-0' : 'mb-2'}" style="white-space: pre-line;">
                        ${message.body.startsWith('[Arquivo:') ? renderFileMessage(message.body) : message.body.trim()}
                    </p>
                    <div class="d-flex justify-content-between align-items-center">
                        <small class="text-muted">
                            ${new Date(message.timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                            &nbsp;
                            ${new Date(message.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </small>
                        <div>
                            ${isBot ? (message.sent_via_whatsapp ? (message.delivered ? `<span class="badge bg-success me-1">✔✔</span>` : `<span class="badge bg-info text-dark me-1">✔</span>`) : `<span class="badge bg-warning text-dark me-1">Pendente</span>`) : ''}
                            ${isBot && !message.sent_via_whatsapp ? `<button class="btn btn-sm btn-link resend-message-btn" data-message-id="${message.id}" title="Reenviar">Reenviar</button>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
        // Função para renderizar mensagem de arquivo como link
        function renderFileMessage(body) {
            // Extrai o nome do arquivo (pode ter timestamp: 1234567890-nome.ext)
            const match = body.match(/\[Arquivo: (.+)\]/);
            if (!match) return body;
            const fullFileName = match[1]; // Nome completo com timestamp
            
            // Extrai nome sem timestamp para exibição (remove prefixo numérico se existir)
            const displayName = fullFileName.replace(/^\d+-/, '');
            
            const ext = displayName.split('.').pop().toLowerCase();
            const fileUrl = `/uploads/${fullFileName}`;
            
            // Verifica áudio primeiro (antes de vídeo) para evitar conflito com .webm
            if (["mp3","ogg","wav"].includes(ext) || (ext === "webm" && fullFileName.includes("audio"))) {
                return `<audio src="${fileUrl}" controls style="width:200px; height:32px; display:block;"></audio>`;
            }
            if (["jpg","jpeg","png","gif","webp"].includes(ext)) {
                return `<a href="${fileUrl}" target="_blank"><img src="${fileUrl}" alt="${displayName}" style="max-width:120px;max-height:120px;border-radius:6px;box-shadow:0 0 4px #ccc;" title="Clique para ampliar"></a>`;
            }
            if (["mp4","mpeg","webm"].includes(ext)) {
                return `<video src="${fileUrl}" controls style="max-width:180px;max-height:120px;"></video><br><a href="${fileUrl}" target="_blank">🎬 ${displayName}</a>`;
            }
            // PDF e documentos
            if (["pdf"].includes(ext)) {
                return `<a href="${fileUrl}" target="_blank">📄 ${displayName}</a>`;
            }
            if (["doc","docx","xls","xlsx","txt"].includes(ext)) {
                return `<a href="${fileUrl}" target="_blank">📎 ${displayName}</a>`;
            }
            // Outros arquivos
            return `<a href="${fileUrl}" target="_blank">📎 ${displayName}</a>`;
        }

        // se houver botão de reenviar, attach handler
        const resendBtn = messageDiv.querySelector('.resend-message-btn');
        if (resendBtn) {
            resendBtn.addEventListener('click', async (e) => {
                const mid = e.currentTarget.getAttribute('data-message-id');
                if (!mid) return;
                e.currentTarget.disabled = true;
                e.currentTarget.textContent = 'Reenviando...';
                try {
                    const resp = await fetch(`/api/messages/${mid}/resend`, { method: 'POST' });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data && data.error ? data.error : (data && data.message ? data.message : 'Erro'));
                    showNotification('Mensagem reenviada com sucesso.', 'success');
                    // atualiza badge localmente
                    const badge = messageDiv.querySelector('.badge');
                    if (badge) {
                        // Ao reenviar manualmente, fica pelo menos como enviado (um tique).
                        badge.className = 'badge bg-info text-dark me-1';
                        badge.textContent = '✔';
                    }
                    if (e.currentTarget && e.currentTarget.remove) {
                        e.currentTarget.remove();
                    }
                } catch (err) {
                    showNotification(`Falha ao reenviar: ${err.message}`, 'danger');
                    if (e.currentTarget) {
                        e.currentTarget.disabled = false;
                        e.currentTarget.textContent = 'Reenviar';
                    }
                }
            });
        }
        chatBody.appendChild(messageDiv);
    }

    // Envia uma nova mensagem
    async function sendMessage(e) {
        e.preventDefault();
        // Debug: logar estado atual para investigar falha de envio
        try {
            console.log('[sendMessage] DEBUG state', {
                activeTicketId,
                currentTicketId,
                messageValue: chatMessageInput ? chatMessageInput.value : null,
                currentUserId: currentUser ? currentUser.id : null
            });
        } catch (dErr) { console.warn('Erro ao logar debug sendMessage:', dErr); }

        if (!activeTicketId || !chatMessageInput.value.trim()) {
            console.warn('[sendMessage] Aborted: activeTicketId ou mensagem vazia', { activeTicketId, message: chatMessageInput ? chatMessageInput.value : null });
            if (!activeTicketId) {
                showNotification('Nenhum ticket ativo. Selecione um ticket antes de enviar mensagens.', 'warning');
            } else if (!chatMessageInput.value.trim()) {
                // apenas evita enviar mensagens vazias
            }
            return;
        }

        // Verifica se o usuário está logado
        if (!currentUser || !currentUser.id) {
            console.error('[sendMessage] Usuário não está logado');
            showNotification('Erro: Usuário não identificado. Faça login novamente.', 'danger');
            window.location.href = '/';
            return;
        }

        // Bloqueia envio de mensagens em tickets concluídos
            try {
                const ticketCheckResponse = await fetch(`/api/tickets?status=resolved${buildUserParams()}`);
                if (ticketCheckResponse.ok) {
                    const resolvedTickets = await ticketCheckResponse.json();
                    const isResolved = resolvedTickets.some(t => t.id === activeTicketId);
                    if (isResolved) {
                        showNotification('Este ticket está concluído. Não é possível enviar mensagens.', 'warning');
                        return;
                    }
                }
            } catch (error) {
                console.error('[sendMessage] Erro ao verificar status do ticket:', error);
            }

        const messageBody = chatMessageInput.value;
        chatMessageInput.value = ''; // Limpa o input imediatamente

        console.log(`[sendMessage] Enviando mensagem para ticket ${activeTicketId}: "${messageBody}"`);

        try {
            const response = await fetch(`/api/tickets/${activeTicketId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    message: messageBody,
                    userId: currentUser.id // Envia o ID do usuário logado
                })
            });
            const result = await response.json();
            if (!response.ok) {
                console.error('[sendMessage] Erro na resposta:', result);
                throw new Error(result.error || result.message || 'Falha ao enviar mensagem.');
            }
            // Log detalhado para facilitar debugging: indica se foi enviado via WhatsApp
            console.log('[sendMessage] Resposta do servidor:', result);
            // A UI será atualizada pelo evento do WebSocket
        } catch (error) {
            console.error('[sendMessage] Erro ao enviar mensagem:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
        chatMessageInput.focus(); // Devolve o foco para o input
    }

    // --- FUNÇÕES AUXILIARES ---

    // Carrega as filas disponíveis e as popula nos seletores dos modais de conexão
    async function populateQueueCheckboxes() {
        try {
            const response = await fetch('/api/queues');
            if (!response.ok) throw new Error('Falha ao carregar filas para os modais.');
            const queues = await response.json();

            // Popula o container do modal de Adicionar WhatsApp (se existir)
            if (addWhatsappForm && addWhatsappForm.queuesContainer) {
                addWhatsappForm.queuesContainer.innerHTML = '';
                queues.forEach(queue => {
                    const checkboxHtml = `
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" value="${queue.id}" id="add-whatsapp-queue-${queue.id}" checked>
                            <label class="form-check-label" for="add-whatsapp-queue-${queue.id}">${queue.name}</label>
                        </div>`;
                    addWhatsappForm.queuesContainer.insertAdjacentHTML('beforeend', checkboxHtml);
                });
            }

            // Popula o container do modal de Editar WhatsApp (se existir)
            if (editWhatsappForm && editWhatsappForm.queuesContainer) {
                editWhatsappForm.queuesContainer.innerHTML = '';
                queues.forEach(queue => {
                    const checkboxHtml = `
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" value="${queue.id}" id="edit-whatsapp-queue-${queue.id}">
                            <label class="form-check-label" for="edit-whatsapp-queue-${queue.id}">${queue.name}</label>
                        </div>`;
                    editWhatsappForm.queuesContainer.insertAdjacentHTML('beforeend', checkboxHtml);
                });
            }
        } catch (error) {
            console.error(error.message);
            // Não mostra um alerta para não ser intrusivo, mas registra o erro.
        }
    }
    // --- FUNÇÕES DE FILAS (QUEUES) ---

    // Carrega e renderiza as filas na tabela
    async function loadQueues() {
        try {
            const response = await fetch('/api/queues');
            if (!response.ok) throw new Error('Falha ao carregar filas.');
            const queues = await response.json();
            
            // Atualiza o mapa de cores
            try {
                queueColorMap = {};
                queues.forEach(q => {
                    if (q && typeof q.id !== 'undefined') queueColorMap[String(q.id)] = q.color || null;
                });
            } catch (e) { queueColorMap = {}; }

            queuesTableBody.innerHTML = ''; // Limpa a tabela
            queues.forEach(renderQueueRow);
        } catch (error) {
            console.error('Erro ao carregar filas:', error);
            showNotification('Não foi possível carregar as filas.', 'danger');
        }
    }

    // Renderiza uma linha na tabela de filas
    function renderQueueRow(queue) {
        const newRow = queuesTableBody.insertRow();
        newRow.setAttribute('data-queue-id', queue.id);
        newRow.innerHTML = `
            <td><span class="badge" style="background-color: ${queue.color}; color: ${queue.color}; border: 1px solid #ccc;">_</span></td>
            <td>${queue.name}</td>
            <td>
                <button class="btn btn-sm btn-info edit-queue-btn" data-id="${queue.id}" title="Editar"><i class="bi bi-pencil"></i></button>
                <button class="btn btn-sm btn-danger delete-queue-btn" data-id="${queue.id}" title="Excluir"><i class="bi bi-trash"></i></button>
            </td>
        `;
    }

    // Adiciona uma nova fila
    async function addQueue(event) {
        event.preventDefault();
        const name = document.getElementById('add-queue-name').value;
        const color = document.getElementById('add-queue-color').value;

        if (!name) {
            showNotification('O nome da fila é obrigatório.', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/queues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao criar a fila.');
            }

            await loadQueues(); // Recarrega a lista
            addQueueForm.reset(); // Limpa o formulário

        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Preenche o modal de edição de fila
    async function openEditQueueModal(id) {
        try {
            const response = await fetch(`/api/queues/${id}`);
            if (!response.ok) throw new Error('Falha ao buscar dados da fila.');
            const queue = await response.json();

            document.getElementById('edit-queue-id').value = queue.id;
            document.getElementById('edit-queue-name').value = queue.name;
            document.getElementById('edit-queue-color').value = queue.color;

            editQueueModal.show();
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Salva as alterações da fila
    async function saveQueueChanges() {
        const id = document.getElementById('edit-queue-id').value;
        const name = document.getElementById('edit-queue-name').value;
        const color = document.getElementById('edit-queue-color').value;

        try {
            const response = await fetch(`/api/queues/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });

            if (!response.ok) throw new Error('Falha ao salvar alterações.');

            editQueueModal.hide();
            await loadQueues();
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Exclui uma fila
    async function deleteQueue() {
        if (!queueIdToDelete) return;

        try {
            const response = await fetch(`/api/queues/${queueIdToDelete}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao excluir a fila.');
            }

            deleteQueueModal.hide();
            await loadQueues(); // Recarrega a lista para refletir a exclusão
            showNotification('Fila excluída com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        } finally {
            queueIdToDelete = null; // Limpa o ID após a operação
        }
    }

    // ============================================
    // FUNÇÕES DE GERENCIAMENTO DE USUÁRIOS
    // ============================================

    let userIdToDelete = null;
    const addUserModal = new bootstrap.Modal(document.getElementById('addUserModal'));
    const editUserModal = new bootstrap.Modal(document.getElementById('editUserModal'));
    const deleteUserModal = new bootstrap.Modal(document.getElementById('deleteUserModal'));

    // === MODAIS DE CONTATO ===
    let contactIdToDelete = null;
    const addContactModal = new bootstrap.Modal(document.getElementById('addContactModal'));
    const editContactModal = new bootstrap.Modal(document.getElementById('editContactModal'));
    const deleteContactModal = new bootstrap.Modal(document.getElementById('deleteContactModal'));

    // Função para salvar alterações do contato (reutilizada por botão e submit do form)
    async function saveContactChanges(e) {
        if (e && e.preventDefault) e.preventDefault();
        try {
            const id = document.getElementById('edit-contact-id').value;
            const name = document.getElementById('edit-contact-name').value.trim();
            const phone = document.getElementById('edit-contact-number').value.trim();
            const info = document.getElementById('edit-contact-info').value.trim();

            console.debug('[contacts] saving contact', { id, name, phone, info });

            if (!name || !phone) {
                showNotification('Nome e telefone são obrigatórios.', 'warning');
                return;
            }

            const resp = await fetch(`/api/contacts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
                body: JSON.stringify({ name, phone, profile_pic_url: info, user_id: currentUser.id })
            });

            console.debug('[contacts] PUT response', resp.status);

            if (!resp.ok) {
                const err = await resp.json().catch(()=>({error:'Falha ao atualizar contato.'}));
                throw new Error(err.error || 'Falha ao atualizar contato.');
            }

            showNotification('Contato atualizado com sucesso!', 'success');
            if (editContactModal) editContactModal.hide();
            await loadContacts();
        } catch (error) {
            console.error('[contacts] save error', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Attach handlers to both the save button and the form submit
    const saveContactChangesBtn = document.getElementById('save-contact-changes-button');
    if (saveContactChangesBtn) saveContactChangesBtn.addEventListener('click', saveContactChanges);
    const editContactForm = document.getElementById('edit-contact-form');
    if (editContactForm) editContactForm.addEventListener('submit', saveContactChanges);

    // === MODAL DE CONFIGURAÇÃO DO CHATBOT ===
    const chatbotConfigForm = {
        welcome_message: document.getElementById('welcome-message'),
        queue_selection_message: document.getElementById('queue-selection-message'),
        waiting_message: document.getElementById('waiting-message'),
        thank_you_message: document.getElementById('thank-you-message'),
        feedback_message: document.getElementById('feedback-message'),
        save_button: document.getElementById('save-chatbot-config')
    };

    // Carrega a lista de usuários
    async function loadUsers() {
        try {
            const response = await fetch('/api/users');
            if (!response.ok) throw new Error('Falha ao carregar usuários.');
            const users = await response.json();

            const tableBody = document.getElementById('users-table-body');
            tableBody.innerHTML = '';

            users.forEach(user => {
                const row = document.createElement('tr');
                
                // Define o badge do perfil
                let profileBadge = '';
                switch(user.profile) {
                    case 'admin':
                        profileBadge = '<span class="badge bg-danger">Administrador</span>';
                        break;
                    case 'supervisor':
                        profileBadge = '<span class="badge bg-warning">Supervisor</span>';
                        break;
                    default:
                        profileBadge = '<span class="badge bg-info">Usuário</span>';
                }

                row.innerHTML = `
                    <td>${user.name}</td>
                    <td>${user.email}</td>
                    <td>${profileBadge}</td>
                    <td>${user.queue_names.join(', ') || '-'}</td>
                    <td class="user-actions">
                        <button class="btn btn-sm btn-info edit-user-btn" data-id="${user.id}" title="Editar"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-danger delete-user-btn" data-id="${user.id}" title="Excluir"><i class="bi bi-trash"></i></button>
                    </td>
                `;
                tableBody.appendChild(row);
            });

            // Atualiza também os checkboxes de filas nos modais
            await populateUserQueueCheckboxes();
        } catch (error) {
            console.error('Erro ao carregar usuários:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Preenche os checkboxes de filas nos modais de usuário
    async function populateUserQueueCheckboxes() {
        try {
            const response = await fetch('/api/queues');
            if (!response.ok) throw new Error('Falha ao carregar filas.');
            const queues = await response.json();

            const addContainer = document.getElementById('add-user-queues-container');
            const editContainer = document.getElementById('edit-user-queues-container');
            
            if (addContainer) {
                addContainer.innerHTML = '';
                queues.forEach(queue => {
                    const div = document.createElement('div');
                    div.className = 'form-check';
                    div.innerHTML = `
                        <input class="form-check-input" type="checkbox" value="${queue.id}" id="add-queue-${queue.id}">
                        <label class="form-check-label" for="add-queue-${queue.id}">
                            ${queue.name}
                        </label>
                    `;
                    addContainer.appendChild(div);
                });
            }

            if (editContainer) {
                editContainer.innerHTML = '';
                queues.forEach(queue => {
                    const div = document.createElement('div');
                    div.className = 'form-check';
                    div.innerHTML = `
                        <input class="form-check-input" type="checkbox" value="${queue.id}" id="edit-queue-${queue.id}">
                        <label class="form-check-label" for="edit-queue-${queue.id}">
                            ${queue.name}
                        </label>
                    `;
                    editContainer.appendChild(div);
                });
            }
        } catch (error) {
            console.error('Erro ao carregar filas:', error);
        }
    }

    // Adiciona um novo usuário
    async function addUser() {
        const name = document.getElementById('add-user-name').value;
        const email = document.getElementById('add-user-email').value;
        const password = document.getElementById('add-user-password').value;
        const profile = document.getElementById('add-user-profile').value;

        // Pega as filas selecionadas
        const queueCheckboxes = document.querySelectorAll('#add-user-queues-container input[type="checkbox"]:checked');
        const queue_ids = Array.from(queueCheckboxes).map(cb => parseInt(cb.value));

        try {
            const response = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password, profile, queue_ids })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao adicionar usuário.');
            }

            const result = await response.json();

            addUserModal.hide();
            document.getElementById('add-user-form').reset();
            await loadUsers();
            
            // Mostrar mensagem apropriada dependendo se o email foi enviado
            if (result.emailSent) {
                showNotification(`Usuário criado com sucesso! Um email de verificação foi enviado para ${email}.`, 'success');
            } else if (result.emailSent === false) {
                showNotification('Usuário criado, mas houve erro ao enviar o email de verificação. Contate o administrador.', 'warning');
            } else {
                showNotification('Usuário adicionado com sucesso!', 'success');
            }
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // === FUNÇÕES DE CONTATOS ===

    async function loadContacts() {
        try {
            const response = await fetch(`/api/contacts?user_id=${currentUser.id}`, { headers: { 'x-session-token': sessionToken } });
            if (!response.ok) throw new Error('Falha ao carregar contatos.');
            const contacts = await response.json();

            // Atualiza cache e renderiza
            contactsCache = contacts || [];
            // Expor para debug no console: window.__contactsCache
            try { window.__contactsCache = contactsCache; window.__renderContacts = renderContacts; } catch(e) { /* ignore */ }
            renderContacts(contactsCache);
            console.debug('[contacts] loadContacts finished, total=', contactsCache.length);
        } catch (error) {
            console.error('Erro ao carregar contatos:', error);
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Renderiza uma lista de contatos na tabela (reutilizável para busca)
    function renderContacts(list) {
        const tableBody = document.getElementById('contacts-table-body');
        if (!tableBody) return;
        tableBody.innerHTML = '';

        if (!list || list.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Nenhum contato encontrado</td></tr>';
            return;
        }

        list.forEach(contact => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${contact.name}</td>
                <td>${contact.phone}</td>
                <td class="contact-actions">
                    <button class="btn btn-sm btn-success initiate-ticket-btn" data-id="${contact.id}" data-name="${contact.name}" data-phone="${contact.phone}" title="Novo Ticket">
                        <i class="bi bi-chat-dots"></i> Novo Ticket
                    </button>
                    <button class="btn btn-sm btn-info edit-contact-btn" data-id="${contact.id}" title="Editar">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger delete-contact-btn" data-id="${contact.id}" title="Excluir">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            `;
            tableBody.appendChild(row);
        });
    }

    // Inicia um atendimento a partir de um contato
    async function initiateTicketFromContact(contactId, contactName, contactPhone) {
        const ok = await showConfirm(`Deseja iniciar um atendimento com ${contactName} (${contactPhone})?`, 'Iniciar atendimento');
        if (!ok) return;

        try {
            // Buscar informações do usuário logado para determinar queue_id
            let queueId = null;
            if (currentUser && currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                queueId = currentUser.queue_ids[0]; // Usa a primeira fila do usuário
            }

            const response = await fetch(`/api/contacts/${contactId}/initiate-ticket`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser ? currentUser.id : null,
                    connectionId: null, // Pode ser determinado automaticamente ou deixar null
                    queueId: queueId
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao iniciar atendimento.');
            }

            const result = await response.json();
            showNotification(`Atendimento iniciado com sucesso! Protocolo: ${result.protocolNumber}`, 'success');

            // Navegar para a aba "Atendendo" para ver o novo ticket
            navigateTo('ingressos');
            if (tabAtendendo) tabAtendendo.click();

        } catch (error) {
            showNotification(`Erro ao iniciar atendimento: ${error.message}`, 'danger');
        }
    }

    // Abre o modal de edição de contato
    async function openEditContactModal(id) {
        try {
            const response = await fetch(`/api/contacts/${id}`, { headers: { 'x-session-token': sessionToken } });
            if (!response.ok) throw new Error('Falha ao buscar dados do contato.');
            const contact = await response.json();

            // Preenche o formulário do modal
            const idEl = document.getElementById('edit-contact-id');
            const nameEl = document.getElementById('edit-contact-name');
            const phoneEl = document.getElementById('edit-contact-number');
            const infoEl = document.getElementById('edit-contact-info');

            if (idEl) idEl.value = contact.id || id;
            if (nameEl) nameEl.value = contact.name || '';
            if (phoneEl) phoneEl.value = contact.phone || '';
            if (infoEl) infoEl.value = contact.profile_pic_url || '';

            // Exibe o modal de edição
            if (typeof editContactModal !== 'undefined' && editContactModal) {
                editContactModal.show();
            } else {
                // Modal de edição não disponível — avisa o usuário e não usa prompt
                showNotification('Modal de edição não disponível. Atualize a página e tente novamente.', 'danger');
                return;
            }
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Abre o modal de edição de usuário
    async function openEditUserModal(id) {
        try {
            const response = await fetch(`/api/users/${id}`);
            if (!response.ok) throw new Error('Falha ao buscar dados do usuário.');
            const user = await response.json();

            document.getElementById('edit-user-id').value = user.id;
            document.getElementById('edit-user-name').value = user.name;
            document.getElementById('edit-user-email').value = user.email;
            document.getElementById('edit-user-profile').value = user.profile;
            document.getElementById('edit-user-password').value = ''; // Limpa o campo de senha

            // Marca as filas que o usuário já tem
            document.querySelectorAll('#edit-user-queues-container input[type="checkbox"]').forEach(cb => {
                cb.checked = user.queue_ids.includes(parseInt(cb.value));
            });

            editUserModal.show();
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Salva as alterações do usuário
    async function saveUserChanges() {
        const id = document.getElementById('edit-user-id').value;
        const name = document.getElementById('edit-user-name').value;
        const email = document.getElementById('edit-user-email').value;
        const password = document.getElementById('edit-user-password').value;
        const profile = document.getElementById('edit-user-profile').value;

        // Pega as filas selecionadas
        const queueCheckboxes = document.querySelectorAll('#edit-user-queues-container input[type="checkbox"]:checked');
        const queue_ids = Array.from(queueCheckboxes).map(cb => parseInt(cb.value));

        const body = { name, email, profile, queue_ids };
        if (password) {
            body.password = password; // Só envia senha se foi preenchida
        }

        try {
            const response = await fetch(`/api/users/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao atualizar usuário.');
            }

            editUserModal.hide();
            await loadUsers();
            showNotification('Usuário atualizado com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Exclui um usuário
    async function deleteUser() {
        if (!userIdToDelete) return;

        try {
            const response = await fetch(`/api/users/${userIdToDelete}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao excluir usuário.');
            }

            deleteUserModal.hide();
            await loadUsers();
            showNotification('Usuário excluído com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        } finally {
            userIdToDelete = null;
        }
    }

    // --- EVENT LISTENERS ---

    logoutButton.addEventListener('click', () => {
        showNotification('Você foi desconectado!', 'info');
        window.location.href = '/';
    });

    menuPainel.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo('painel');
    });

    menuConexoes.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo('conexoes');
    });

    menuIngressos.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo('ingressos');
    });

    menuFilas.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo('filas');
    });

    // Botão superior que substitui a antiga "Caixa de Entrada" — abre a aba Contatos
    if (navContatos) {
        navContatos.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo('contatos');
        });
    }

    addWhatsappForm.form.addEventListener('submit', addConnection);
    confirmDeleteButton.addEventListener('click', deleteConnection);
    editWhatsappForm.button.addEventListener('click', saveConnectionChanges);

    // Event listeners para a seção de Filas
    addQueueForm.addEventListener('submit', addQueue);
    document.getElementById('save-queue-changes-button').addEventListener('click', saveQueueChanges);
    document.getElementById('confirm-delete-queue-button').addEventListener('click', deleteQueue);

    queuesTableBody.addEventListener('click', (event) => {
        const editButton = event.target.closest('.edit-queue-btn');
        if (editButton) {
            openEditQueueModal(editButton.getAttribute('data-id'));
        }
        const deleteButton = event.target.closest('.delete-queue-btn');
        if (deleteButton) {
            // Define o ID da fila a ser excluída e abre o modal de confirmação
            queueIdToDelete = deleteButton.getAttribute('data-id');
            deleteQueueModal.show();
        }
    });

    // Corrige o problema de foco no modal de QR Code ao ser fechado
    qrCodeModalEl.addEventListener('hidden.bs.modal', async function () {
        if (activeQrConnectionId) {
            // Verifica se a conexão já está conectada antes de abortar
            try {
                const response = await fetch(`/api/connections/${activeQrConnectionId}`);
                if (response.ok) {
                    const connection = await response.json();
                    if (connection.status === 'CONNECTED') {
                        console.log(`Conexão ${activeQrConnectionId} já está conectada. Não abortando.`);
                        activeQrConnectionId = null;
                        return;
                    }
                }
            } catch (error) {
                console.error('Erro ao verificar status da conexão:', error);
            }
            
            console.log(`Modal do QR fechado. Abortando inicialização para a conexão: ${activeQrConnectionId}`);
            try {
                // Notifica o servidor para abortar a sessão pendente
                await fetch(`/api/connections/${activeQrConnectionId}/abort`, { method: 'POST' });
            } catch (error) {
                console.error('Falha ao enviar requisição para abortar a sessão:', error);
            } finally {
                // Limpa o estado independentemente do resultado da requisição
                activeQrConnectionId = null;
            }
        }

        const closeButton = qrCodeModalEl.querySelector('.btn-close');
        if (closeButton) {
            closeButton.blur();
        }
    });

    // Corrige o problema de foco no modal de exclusão ao ser fechado
    deleteConnectionModalEl.addEventListener('hidden.bs.modal', function () {
        const focusedButton = deleteConnectionModalEl.querySelector('.btn-danger');
        if (focusedButton) {
            focusedButton.blur();
        }
    });

    // Carrega as mensagens salvas quando o modal de adicionar é aberto
    addWhatsappModalEl.addEventListener('show.bs.modal', function () {
        loadAddWhatsappMessages();
    });

    // Corrige o problema de foco no modal de adição ao ser fechado
    addWhatsappModalEl.addEventListener('hidden.bs.modal', function () {
        const closeButton = addWhatsappModalEl.querySelector('.btn-close');
        if (closeButton) {
            closeButton.blur();
        }
    });

    // --- EVENT LISTENERS ---

    // Listener de clique principal para toda a área de conteúdo
    mainContentArea.addEventListener('click', (event) => {
        const target = event.target;

        // Ações na tabela de Conexões
        const connectionRow = target.closest('#conexoes-content tr');
        if (connectionRow) {
            const deleteBtn = target.closest('.delete-btn');
            if (deleteBtn) {
                connectionIdToDelete = deleteBtn.getAttribute('data-id');
                deleteConnectionModal.show();
                return;
            }
            const editBtn = target.closest('.edit-btn');
            if (editBtn) {
                openEditModal(editBtn.getAttribute('data-id'));
                return;
            }
        }

        // Ações na tabela de Filas
        const queueRow = target.closest('#filas-content tr');
        if (queueRow) {
            const editQueueBtn = target.closest('.edit-queue-btn');
            if (editQueueBtn) {
                openEditQueueModal(editQueueBtn.getAttribute('data-id'));
                return;
            }
            const deleteQueueBtn = target.closest('.delete-queue-btn');
            if (deleteQueueBtn) {
                queueIdToDelete = deleteQueueBtn.getAttribute('data-id');
                deleteQueueModal.show();
                return;
            }
        }

        // Ações na tabela de Usuários
        const userRow = target.closest('#usuarios-content tr');
        if (userRow) {
            const editUserBtn = target.closest('.edit-user-btn');
            if (editUserBtn) {
                openEditUserModal(editUserBtn.getAttribute('data-id'));
                return;
            }
            const deleteUserBtn = target.closest('.delete-user-btn');
            if (deleteUserBtn) {
                userIdToDelete = deleteUserBtn.getAttribute('data-id');
                deleteUserModal.show();
                return;
            }
        }

        // Ações na tabela de Contatos
        const contactRow = target.closest('#contatos-content tr');
        if (contactRow) {
            const initiateTicketBtn = target.closest('.initiate-ticket-btn');
            if (initiateTicketBtn) {
                const contactId = initiateTicketBtn.getAttribute('data-id');
                const contactName = initiateTicketBtn.getAttribute('data-name');
                const contactPhone = initiateTicketBtn.getAttribute('data-phone');
                initiateTicketFromContact(contactId, contactName, contactPhone);
                return;
            }
            const editContactBtn = target.closest('.edit-contact-btn');
            if (editContactBtn) {
                openEditContactModal(editContactBtn.getAttribute('data-id'));
                return;
            }
            const deleteContactBtn = target.closest('.delete-contact-btn');
            if (deleteContactBtn) {
                contactIdToDelete = deleteContactBtn.getAttribute('data-id');
                deleteContactModal.show();
                return;
            }
        }

        // Ações na lista de Tickets
        const ticketItem = target.closest('#ticket-list .list-group-item');
        if (ticketItem) {
            // Instrumentação: log do clique no ticket para debug de abertura em Pendente
            try {
                const dbgId = ticketItem.getAttribute('data-ticket-id');
                const dbgConn = ticketItem.getAttribute('data-connection-id');
                const dbgHold = ticketItem.getAttribute('data-is-on-hold');
                console.log('[CLICK-TICKET] clicked ticketId=', dbgId, 'conn=', dbgConn, 'is_on_hold=', dbgHold, 'currentTicketStatus=', currentTicketStatus, 'currentTicketView=', currentTicketView);
            } catch(e) { console.warn('[CLICK-TICKET] debug failed', e); }
            const ticketId = ticketItem.getAttribute('data-ticket-id');
            const ticketStatus = ticketItem.getAttribute('data-status');
            
            // Se clicar no botão "Aceitar" (apenas na aba aguardando/pending)
            const acceptBtn = target.closest('.accept-ticket-btn');
            if (acceptBtn && currentTicketStatus === 'pending') {
                attendTicket(ticketId);
                // Após aceitar, muda para a aba "Atendendo"
                if (tabAtendendo) tabAtendendo.click();
                return;
            }
            // Se estiver na aba aguardando, normalmente não permite abrir o chat,
            // mas permitimos para tickets manuais (sem connection_id) que não estejam em hold.
            if (currentTicketStatus === 'pending') {
                const conn = ticketItem.getAttribute('data-connection-id');
                const isOnHold = ticketItem.getAttribute('data-is-on-hold');
                // Se tem connection_id definida (atendimento normal) ou está em hold, bloqueia
                // EXCETO se o agente logado for o dono do ticket (pode reabrir seu próprio pending)
                const ticketOwner = ticketItem.getAttribute('data-ticket-user-id');
                const ownerIsCurrent = ticketOwner && currentUser && String(currentUser.id) === String(ticketOwner);
                if (!ownerIsCurrent && ((conn && conn !== '' && conn !== 'null') || (isOnHold && (isOnHold === '1' || isOnHold === 'true')))) {
                    console.log('[CLICK-TICKET] blocking open for pending ticketId=', ticketId, 'conn=', conn, 'isOnHold=', isOnHold, 'ownerIsCurrent=', ownerIsCurrent);
                    return;
                }
                // Caso seja ticket manual (sem connection_id) e não esteja em hold, permitir abrir
            }
            // Se não for o botão aceitar e não está na aba aguardando, abre o chat normalmente
            // Tickets concluídos podem ser abertos para visualização
            loadChat(ticketId);
            return;
        }

        // Ações no cabeçalho do Chat
        const chatHeaderButton = target.closest('#chat-header button');
        if (chatHeaderButton) {
            switch (chatHeaderButton.id) {
                case 'resolve-ticket-button':
                    resolveTicket();
                    break;
                case 'pendente-ticket-button':
                    reopenTicket();
                    break;
                case 'continuar-ticket-button':
                    continuePendingTicket();
                    break;
                case 'delete-ticket-button':
                    openDeleteTicketModal(activeTicketId);
                    break;
                case 'transfer-ticket-button':
                    openTransferTicketModal(activeTicketId);
                    break;
            }
            return;
        }
    });

    async function continuePendingTicket() {
        if (!activeTicketId) return;
        try {
            // Preparar dados para enviar
            const updateData = { status: 'attending', on_hold: 0 };
            
            // Se tiver usuário logado, adiciona user_id e queue_id
            if (currentUser && currentUser.id) {
                updateData.user_id = currentUser.id;
                // Se o usuário tiver filas, usa a primeira
                if (currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                    updateData.queue_id = currentUser.queue_ids[0];
                }
            }
            
            const resp = await fetch(`/api/tickets/${activeTicketId}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });
            if (!resp.ok) throw new Error('Falha ao continuar atendimento');
            await loadChat(activeTicketId); // Recarrega chat e lista com novo estado
        } catch (e) {
            console.error(e);
            showNotification(e.message || 'Erro desconhecido', 'danger');
        }
    }

    // Listeners de Navegação e Ações Globais
    logoutButton.addEventListener('click', async () => {
        // Limpa a sessão no servidor
        if (currentUser && sessionToken) {
            try {
                await fetch('/api/users/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUser.id, 
                        sessionToken: sessionToken 
                    })
                });
            } catch (error) {
                console.error('Erro ao fazer logout:', error);
            }
        }
        
        // Para os intervalos
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (onlineUsersInterval) clearInterval(onlineUsersInterval);
        
        // Limpa o localStorage
        localStorage.removeItem('currentUser');
        localStorage.removeItem('sessionToken');
        
        showNotification('Você foi desconectado!', 'info');
        window.location.href = '/';
    });

    menuPainel.addEventListener('click', (e) => { e.preventDefault(); navigateTo('painel'); });
    menuConexoes.addEventListener('click', (e) => { e.preventDefault(); navigateTo('conexoes'); });
    menuIngressos.addEventListener('click', (e) => { e.preventDefault(); navigateTo('ingressos'); });
    menuFilas.addEventListener('click', (e) => { e.preventDefault(); navigateTo('filas'); });
    if (menuUsuarios) menuUsuarios.addEventListener('click', (e) => { e.preventDefault(); navigateTo('usuarios'); });
    if (menuContatos) menuContatos.addEventListener('click', (e) => { e.preventDefault(); navigateTo('contatos'); });
    if (menuRespostasRapidas) menuRespostasRapidas.addEventListener('click', (e) => { e.preventDefault(); navigateTo('respostas-rapidas'); });
    if (menuChatInterno) menuChatInterno.addEventListener('click', (e) => { e.preventDefault(); navigateTo('chat-interno'); });

    // Listeners de Formulários e Modais
    addWhatsappForm.form.addEventListener('submit', addConnection);
    confirmDeleteButton.addEventListener('click', deleteConnection);
    editWhatsappForm.button.addEventListener('click', saveConnectionChanges);
    addQueueForm.addEventListener('submit', addQueue);
    document.getElementById('save-queue-changes-button').addEventListener('click', saveQueueChanges);
    document.getElementById('confirm-delete-queue-button').addEventListener('click', deleteQueue);
    confirmDeleteTicketButton.addEventListener('click', confirmDeleteTicket);
    document.getElementById('confirm-transfer-button').addEventListener('click', confirmTransferTicket);
    chatForm.addEventListener('submit', sendMessage);
    if (chatbotConfigForm.save_button) chatbotConfigForm.save_button.addEventListener('click', saveChatbotConfig);

    // Carrega configuração do chatbot quando o modal é aberto
    if (chatbotConfigModalEl) {
        chatbotConfigModalEl.addEventListener('show.bs.modal', async () => {
            try {
                const response = await fetch('/api/chatbot/config');
                if (response.ok) {
                    const config = await response.json();
                    chatbotConfigForm.welcome_message.value = config.welcome_message || '';
                    chatbotConfigForm.queue_selection_message.value = config.queue_selection_message || '';
                    chatbotConfigForm.waiting_message.value = config.waiting_message || '';
                    chatbotConfigForm.thank_you_message.value = config.thank_you_message || '';
                    chatbotConfigForm.feedback_message.value = config.feedback_message || '';
                }
            } catch (error) {
                console.error('Erro ao carregar configuração do chatbot:', error);
            }
        });
    }

    // --- ÁUDIO: Gravação e envio ---
    const recordAudioButton = document.getElementById('record-audio-button');
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    if (recordAudioButton) {
        recordAudioButton.addEventListener('click', async (e) => {
            e.preventDefault();
            if (isRecording) {
                // Parar gravação
                mediaRecorder && mediaRecorder.stop();
                recordAudioButton.classList.remove('btn-danger');
                recordAudioButton.classList.add('btn-secondary');
                recordAudioButton.innerHTML = '<i class="bi bi-mic-fill"></i>';
                isRecording = false;
                return;
            }
            // Iniciar gravação
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                showNotification('Seu navegador não suporta gravação de áudio.', 'warning');
                return;
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                let mimeType = '';
                if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
                    mimeType = 'audio/ogg;codecs=opus';
                } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                    mimeType = 'audio/webm;codecs=opus';
                } else {
                    mimeType = '';
                }
                mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) audioChunks.push(event.data);
                };
                mediaRecorder.onstop = async () => {
                    // Detecta o tipo do blob gerado
                    const blobType = audioChunks[0]?.type || 'audio/webm';
                    const ext = blobType.includes('ogg') ? 'ogg' : 'webm';
                    const audioBlob = new Blob(audioChunks, { type: blobType });
                    if (audioBlob.size === 0) return;
                    if (!activeTicketId) {
                        showNotification('Selecione um ticket primeiro.', 'warning');
                        return;
                    }
                    // Valida tamanho (máx 16MB)
                    if (audioBlob.size > 16 * 1024 * 1024) {
                        showNotification('Áudio muito grande. O tamanho máximo é 16MB.', 'warning');
                        return;
                    }
                    
                    // Verifica se o usuário está logado
                    if (!currentUser || !currentUser.id) {
                        console.error('[AudioUpload] Usuário não está logado');
                        showNotification('Erro: Usuário não identificado. Faça login novamente.', 'danger');
                        return;
                    }
                    
                    // Bloqueia envio de áudio em tickets concluídos
                    try {
                        const ticketCheckResponse = await fetch(`/api/tickets?status=resolved${buildUserParams()}`);
                        if (ticketCheckResponse.ok) {
                            const resolvedTickets = await ticketCheckResponse.json();
                            const isResolved = resolvedTickets.some(t => t.id === activeTicketId);
                            if (isResolved) {
                                showNotification('Este ticket está concluído. Não é possível enviar áudios.', 'warning');
                                return;
                            }
                        }
                    } catch (error) {
                        console.error('[AudioUpload] Erro ao verificar status do ticket:', error);
                    }
                    
                    // Indicador de upload
                    const uploadIndicator = document.createElement('div');
                    uploadIndicator.className = 'alert alert-info mt-2';
                    uploadIndicator.textContent = '🔊 Enviando áudio...';
                    chatBody.appendChild(uploadIndicator);
                    chatBody.scrollTop = chatBody.scrollHeight;
                    try {
                        const formData = new FormData();
                        formData.append('file', audioBlob, `audio.${ext}`);
                        formData.append('ticketId', activeTicketId);
                        formData.append('userId', currentUser.id); // Adiciona userId
                        const response = await fetch('/api/send-file', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await response.json();
                        uploadIndicator.remove();
                        if (response.ok) {
                            await refreshActiveChat();
                        } else {
                            showNotification(data.error || 'Erro ao enviar áudio.', 'danger');
                        }
                    } catch (err) {
                        uploadIndicator.remove();
                        showNotification('Erro ao enviar áudio. Tente novamente.', 'danger');
                    }
                };
                mediaRecorder.start();
                isRecording = true;
                recordAudioButton.classList.remove('btn-secondary');
                recordAudioButton.classList.add('btn-danger');
                recordAudioButton.innerHTML = '<i class="bi bi-stop-fill"></i>';
            } catch (err) {
                showNotification('Não foi possível acessar o microfone.', 'danger');
            }
        });
    }

    // Listener para anexar arquivo
    const attachFileButton = document.getElementById('attach-file-button');
    const fileInput = document.getElementById('file-input');
    
    console.log('Botão de anexar arquivo:', attachFileButton);
    console.log('Input de arquivo:', fileInput);
    
    if (attachFileButton && fileInput) {
        console.log('✅ Elementos encontrados! Adicionando event listeners...');
        
        attachFileButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Botão de anexar clicado!');
            fileInput.click();
        });
        
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            console.log('Arquivo selecionado:', file);
            if (!file) return;
            
            console.log('activeTicketId:', activeTicketId);
            if (!activeTicketId) {
                showNotification('Selecione um ticket primeiro.', 'warning');
                fileInput.value = '';
                return;
            }
            
            // Verifica se o usuário está logado
            if (!currentUser || !currentUser.id) {
                console.error('[FileUpload] Usuário não está logado');
                showNotification('Erro: Usuário não identificado. Faça login novamente.', 'danger');
                fileInput.value = '';
                return;
            }
            
            // Bloqueia envio de arquivos em tickets concluídos
            try {
                const ticketCheckResponse = await fetch(`/api/tickets?status=resolved${buildUserParams()}`);
                if (ticketCheckResponse.ok) {
                    const resolvedTickets = await ticketCheckResponse.json();
                    const isResolved = resolvedTickets.some(t => t.id === activeTicketId);
                    if (isResolved) {
                        showNotification('Este ticket está concluído. Não é possível enviar arquivos.', 'warning');
                        fileInput.value = '';
                        return;
                    }
                }
            } catch (error) {
                console.error('[FileUpload] Erro ao verificar status do ticket:', error);
            }
            
            // Validar tamanho do arquivo (máximo 16MB)
            const maxSize = 16 * 1024 * 1024; // 16MB em bytes
            if (file.size > maxSize) {
                showNotification('Arquivo muito grande. O tamanho máximo é 16MB.', 'warning');
                fileInput.value = '';
                return;
            }
            
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('ticketId', activeTicketId);
                formData.append('userId', currentUser.id); // Adiciona userId
                
                console.log('Enviando arquivo para API...');
                
                // Mostrar indicador de upload
                const uploadIndicator = document.createElement('div');
                uploadIndicator.className = 'alert alert-info mt-2';
                uploadIndicator.textContent = `📎 Enviando arquivo: ${file.name}...`;
                chatBody.appendChild(uploadIndicator);
                chatBody.scrollTop = chatBody.scrollHeight;
                
                const response = await fetch('/api/send-file', {
                    method: 'POST',
                    body: formData
                });
                
                console.log('Resposta da API:', response.status);
                const data = await response.json();
                console.log('Dados da resposta:', data);
                
                // Remover indicador de upload
                uploadIndicator.remove();
                
                if (response.ok) {
                    // Recarregar mensagens para mostrar o arquivo enviado
                    await refreshActiveChat();
                } else {
                    showNotification(data.error || 'Erro ao enviar arquivo.', 'danger');
                }
            } catch (error) {
                console.error('Erro ao enviar arquivo:', error);
                showNotification('Erro ao enviar arquivo. Tente novamente.', 'danger');
            } finally {
                fileInput.value = ''; // Limpar input
            }
        });
    }

    // Listeners de Usuários
    const saveNewUserButton = document.getElementById('save-new-user-button');
    if (saveNewUserButton) {
        saveNewUserButton.addEventListener('click', addUser);
    }
    
    const saveUserChangesButton = document.getElementById('save-user-changes-button');
    if (saveUserChangesButton) {
        saveUserChangesButton.addEventListener('click', saveUserChanges);
    }
    
    const confirmDeleteUserButton = document.getElementById('confirm-delete-user-button');
    if (confirmDeleteUserButton) {
        confirmDeleteUserButton.addEventListener('click', deleteUser);
    }

    // Listeners de Contatos
    // O botão lateral 'add-contact-button' abre o modal (data-bs-toggle). O envio é tratado pelo botão de salvar do modal.
    const addContactButton = document.getElementById('add-contact-button');

    // Handler para salvar um novo contato a partir do modal
    const saveNewContactButton = document.getElementById('save-new-contact-button');
    if (saveNewContactButton) {
        saveNewContactButton.addEventListener('click', async () => {
            try {
                const nameEl = document.getElementById('add-contact-name');
                const phoneEl = document.getElementById('add-contact-number');
                const infoEl = document.getElementById('add-contact-info');
                if (!nameEl || !phoneEl) { showNotification('Formulário incompleto.', 'warning'); return; }

                const name = nameEl.value.trim();
                const phone = phoneEl.value.trim();
                const info = infoEl ? infoEl.value.trim() : '';

                if (!name || !phone) {
                    showNotification('Nome e Número do WhatsApp são obrigatórios.', 'warning');
                    return;
                }

                const response = await fetch('/api/contacts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
                    body: JSON.stringify({ name, phone, profile_pic_url: info, user_id: currentUser.id })
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || err.message || 'Falha ao adicionar contato.');
                }

                // Sucesso
                showNotification('Contato adicionado com sucesso!', 'success');
                // Fecha o modal e limpa o formulário
                try { if (addContactModal) addContactModal.hide(); } catch (e) { /* ignore */ }
                const form = document.getElementById('add-contact-form');
                if (form) form.reset();
                // Recarrega a lista de contatos
                await loadContacts();
            } catch (error) {
                console.error('Erro ao adicionar contato:', error);
                showNotification(`Erro: ${error.message}`, 'danger');
            }
        });
    }

    const confirmDeleteContactButton = document.getElementById('confirm-delete-contact-button');
    if (confirmDeleteContactButton) {
        confirmDeleteContactButton.addEventListener('click', () => {
            if (!contactIdToDelete) return;

            fetch(`/api/contacts/${contactIdToDelete}?user_id=${currentUser.id}`, {
                method: 'DELETE',
                headers: { 'x-session-token': sessionToken }
            })
            .then(response => {
                if (!response.ok) throw new Error('Falha ao deletar contato.');
                return response.json();
            })
            .then(() => {
                showNotification('Contato removido com sucesso!', 'success');
                deleteContactModal.hide();
                loadContacts();
            })
            .catch(error => {
                showNotification(`Erro: ${error.message}`, 'danger');
            });
        });
    }

    // Listeners de abas de Tickets
    tabAtendendo.addEventListener('click', (e) => {
        e.preventDefault();
        if (currentTicketView !== 'inbox') currentTicketView = 'inbox';
        currentTicketStatus = 'attending';
        // Atendendo = verde
        if (tabAtendendo) {
            tabAtendendo.classList.remove('btn-outline-secondary','btn-danger','btn-warning');
            tabAtendendo.classList.add('btn-success');
        }
        if (tabAguardando) {
            tabAguardando.classList.remove('btn-danger','btn-success','btn-warning');
            tabAguardando.classList.add('btn-outline-secondary');
        }
        const tabPendenteLocal = document.getElementById('tab-pendente');
        if (tabPendenteLocal) {
            tabPendenteLocal.classList.remove('btn-warning','btn-success','btn-danger');
            tabPendenteLocal.classList.add('btn-outline-secondary');
        }
        persistState();
        loadTickets();
    });

    tabAguardando.addEventListener('click', async (e) => {
        e.preventDefault();
    shouldShowAguardando = false; // Resetar notificação ao clicar na aba
        if (currentTicketView !== 'inbox') currentTicketView = 'inbox';
        currentTicketStatus = 'pending';
        currentPage = 1;
        // Aguardando = vermelho
        if (tabAguardando) {
            tabAguardando.classList.remove('btn-outline-secondary','btn-success','btn-warning');
            tabAguardando.classList.add('btn-danger');
        }
        if (tabAtendendo) {
            tabAtendendo.classList.remove('btn-success','btn-danger','btn-warning');
            tabAtendendo.classList.add('btn-outline-secondary');
        }
        const tabPendenteLocal = document.getElementById('tab-pendente');
        if (tabPendenteLocal) {
            tabPendenteLocal.classList.remove('btn-warning','btn-success','btn-danger');
            tabPendenteLocal.classList.add('btn-outline-secondary');
        }
        persistState();
        await loadTickets();
    });

    if (navContatos) {
        navContatos.addEventListener('click', async (e) => {
            e.preventDefault();
            currentTicketView = 'inbox';
            currentPage = 1;
            navContatos.classList.replace('btn-outline-secondary', 'btn-primary');
            if (navResolved) navResolved.classList.replace('btn-primary', 'btn-outline-secondary');
            const navUnderline = document.querySelector('.nav-underline');
            if (navUnderline) navUnderline.classList.remove('d-none');
            // Ao trocar de visão, limpa seleção de ticket e mostra placeholder
            activeTicketId = null;
            persistState();
            showChatPlaceholder();
            await loadTickets();
        });
    }

    if (navResolved) {
        navResolved.addEventListener('click', (e) => {
            e.preventDefault();
            currentTicketView = 'resolved';
            currentPage = 1;
            navResolved.classList.replace('btn-outline-secondary', 'btn-primary');
            if (navContatos) navContatos.classList.replace('btn-primary', 'btn-outline-secondary');
            const navUnderline = document.querySelector('.nav-underline');
            if (navUnderline) navUnderline.classList.add('d-none');
            // Ao trocar de visão, limpa seleção de ticket e mostra placeholder
            activeTicketId = null;
            persistState();
            showChatPlaceholder();
            loadTickets();
        });
    } else {
        console.warn('[dashboard] Elemento #nav-resolved inexistente - fluxo RESOLVIDOS desabilitado.');
    }

    // Listener para a aba 'Pendente'
    const tabPendente = document.getElementById('tab-pendente');
    if (tabPendente) {
        tabPendente.addEventListener('click', async (e) => {
            e.preventDefault();
            currentTicketView = 'pending';
            // garante que o status usado para carregar tickets corresponda à view PENDENTE
            currentTicketStatus = 'pending';
            currentPage = 1;
            if (navContatos) navContatos.classList.replace('btn-outline-secondary', 'btn-primary');
            if (navResolved) navResolved.classList.replace('btn-primary', 'btn-outline-secondary');
            const navUnderlineLocal = document.querySelector('.nav-underline');
            if (navUnderlineLocal) navUnderlineLocal.classList.remove('d-none');
            const subTabsContainer2 = document.getElementById('inbox-subtabs-container');
            if (subTabsContainer2) subTabsContainer2.classList.remove('d-none');
            // PENDENTE = amarelo
            tabPendente.classList.remove('btn-outline-secondary','btn-success','btn-danger');
            tabPendente.classList.add('btn-warning');
            // Neutraliza outras abas
            if (tabAtendendo) {
                tabAtendendo.classList.remove('btn-success','btn-danger','btn-warning');
                tabAtendendo.classList.add('btn-outline-secondary');
            }
            if (tabAguardando) {
                tabAguardando.classList.remove('btn-danger','btn-success','btn-warning');
                tabAguardando.classList.add('btn-outline-secondary');
            }
            const dbgInfo = document.getElementById('pending-debug-info');
            if (dbgInfo) dbgInfo.textContent = 'Carregando PENDENTE...';
            const noTickets = document.getElementById('no-tickets-message');
            if (noTickets) noTickets.classList.add('d-none');
            const ticketList = document.getElementById('ticket-list');
            if (ticketList) ticketList.classList.remove('d-none');
            // Ao trocar de sub-aba, limpa seleção de ticket e mostra placeholder
            activeTicketId = null;
            persistState();
            showChatPlaceholder();
            await loadTickets();
        });
    }

    // Listener para a aba 'Resolvido'
    const tabResolvido = document.getElementById('tab-resolvido');
    if (tabResolvido) {
        tabResolvido.addEventListener('click', async (e) => {
            e.preventDefault();
            currentTicketView = 'resolved';
            currentPage = 1;
            // Ao trocar de sub-aba, limpa seleção de ticket e mostra placeholder
            activeTicketId = null;
            persistState();
            showChatPlaceholder();
            // Aguarda o carregamento para garantir que o ajuste de altura seja aplicado
            await loadTickets();
        });
    }

    // Listeners adicionais para abas Aguardando e Atendendo (se existirem no DOM)
    // Removido listener duplicado para 'tab-aguardando' que causava conflito
    // const tabAguardandoEl = document.getElementById('tab-aguardando');
    // if (tabAguardandoEl) {
    //     tabAguardandoEl.addEventListener('click', (e) => {
    //         e.preventDefault();
    //         currentTicketView = 'awaiting';
    //         activeTicketId = null;
    //         persistState();
    //         showChatPlaceholder();
    //         loadTickets();
    //     });
    // }
    const tabAtendendoEl = document.getElementById('tab-atendendo');
    if (tabAtendendoEl) {
        tabAtendendoEl.addEventListener('click', (e) => {
            e.preventDefault();
            currentTicketView = 'attending';
            activeTicketId = null;
            currentPage = 1;
            persistState();
            showChatPlaceholder();
            loadTickets();
        });
    }

    // --- WEBSOCKET LISTENERS ---

    socket.on('ticket_update', (data) => {
        console.log('Atualização de ticket recebida:', data);
        const wasViewingPendingBefore = (currentTicketView === 'pending');
        // Se estamos na aba PENDENTE e o update também é para 'pending',
        // não recarregamos a lista nem mudamos a view — apenas atualizamos o item local.
        if (currentTicketView === 'pending' && data.status === 'pending') {
            try {
                const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${data.id}']`);
                if (ticketEl) {
                    if (data.last_message) {
                        const snippetEl = ticketEl.querySelector('.ticket-info-content p');
                        if (snippetEl) snippetEl.textContent = data.last_message;
                    }
                    if (data.last_message_at) {
                        const timeEl = ticketEl.querySelector('.ticket-info-content small.text-muted');
                        if (timeEl) timeEl.textContent = new Date(data.last_message_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
                    }
                    // atualiza unread se fornecido
                    if (typeof data.unread_messages !== 'undefined') {
                        const unreadBadge = ticketEl.querySelector('.badge');
                        if (unreadBadge) {
                            unreadBadge.textContent = String(data.unread_messages);
                            unreadBadge.classList.toggle('d-none', Number(data.unread_messages) === 0);
                        }
                    }
                }
            } catch (e) { console.warn('Falha ao aplicar ticket_update localmente para PENDENTE', e); }
            return; // evita loadTickets e evita mudar de aba
        }
        // Se a atualização tenta mover um ticket para 'attending' por um evento externo,
        // não forçamos a remoção se o usuário está navegando na aba 'PENDENTE'.
        // Isso assegura que tickets listados como pendente permanecem nessa aba até
        // que o agente clique em "Continuar Atendimento".
        try {
            if (data.status === 'attending') {
                const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${data.id}']`);
                const isViewingPending = currentTicketView === 'pending' || currentTicketStatus === 'pending';
                const localWasPending = ticketEl && ticketEl.getAttribute('data-status') === 'pending';

                // Se estamos na aba PENDENTE e o ticket ainda aparece localmente como pending,
                // ignoramos a tentativa de promovê-lo para attending no cliente.
                if (isViewingPending && localWasPending) {
                    console.info('[dashboard] Ignorando ticket_update -> attending para ticket em PENDENTE enquanto usuário está na aba PENDENTE:', data.id);
                    // Atualiza indicadores, mas não remove o elemento nem fecha o chat.
                    try { refreshTicketIndicators(); } catch (e) { /* ignore */ }
                    return;
                }

                // Caso contrário, aplica o comportamento original: se o ticket foi atribuído a outro agente,
                // remove da lista e fecha o chat se necessário.
                if (data.user_id && currentUser && data.user_id != currentUser.id) {
                    if (ticketEl) {
                        ticketEl.remove();
                        refreshTicketIndicators();
                    }
                    if (activeTicketId == data.id) {
                        activeTicketId = null;
                        chatArea.classList.add('d-none');
                        chatWelcomeMessage.classList.remove('d-none');
                    }
                }
            }
        } catch (e) {
            console.warn('Erro ao processar atualização de ticket:', e);
        }
        
        // Mostrar notificação se for novo ticket ou transferido por outro agente
        if (data.status === 'pending') {
            shouldShowAguardando = true;
        } else if (data.status === 'transferred' && data.transferUserId && currentUser && data.transferUserId != currentUser.id) {
            shouldShowAguardando = true;
        }
        
        // Atualiza todos os indicadores (inclui updateDashboardStats internamente)
        refreshTicketIndicators();

        // Se o ticket atualizado for o que está ativo na tela
        if (data.id == activeTicketId) {
            if (data.status === 'deleted') {
                // Se foi deletado, limpa a tela de chat
                chatArea.classList.add('d-none');
                chatWelcomeMessage.classList.remove('d-none');
                activeTicketId = null;
            }
            refreshActiveChat();
        }
        // Se estamos visualizando a aba PENDENTE e o ticket local também está marcado como pending,
        // evitamos recarregar toda a lista (isso evita que a UI pule para 'Aguardando').
        try {
            const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${data.id}']`);
            const localWasPending = ticketEl && ticketEl.getAttribute('data-status') === 'pending';
            if (wasViewingPendingBefore && localWasPending) {
                // Apenas atualiza indicadores e o elemento específico, sem reload completo
                try {
                    if (ticketEl) {
                        // Atualiza último texto e timestamp se fornecido
                        const snippetEl = ticketEl.querySelector('.ticket-info-content p');
                        if (snippetEl && data.last_message) snippetEl.textContent = data.last_message;
                        const timeEl = ticketEl.querySelector('.ticket-info-content small.text-muted');
                        if (timeEl && data.last_message_at) timeEl.textContent = new Date(data.last_message_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
                    }
                } catch (e) { console.warn('Falha ao atualizar ticket localmente após ticket_update', e); }
                return; // evita loadTickets
            }

            // Se o ticket existe na lista (em qualquer aba), apenas atualiza localmente sem reload
            if (ticketEl) {
                // Atualiza snippet e timestamp se fornecido
                try {
                    const snippetEl = ticketEl.querySelector('.ticket-info-content p');
                    if (snippetEl && data.last_message) snippetEl.textContent = data.last_message;
                    const timeEl = ticketEl.querySelector('.ticket-info-content small.text-muted');
                    if (timeEl && data.last_message_at) timeEl.textContent = new Date(data.last_message_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
                } catch (e) { console.warn('Falha ao atualizar ticket localmente após ticket_update', e); }
                return; // evita loadTickets
            }

            // Apenas recarrega se o ticket não existe na lista atual (novo ticket ou mudança de aba)
            loadTickets().catch(e => { console.warn('Erro ao recarregar tickets após ticket_update', e); });
        } catch (e) {
            console.warn('Erro no processamento condicional de ticket_update', e);
            loadTickets().catch(e => { console.warn('Erro ao recarregar tickets após ticket_update', e); });
        }
    });

    socket.on('new-message', (data) => {
        console.log('Nova mensagem recebida:', data);
        const wasViewingPendingBefore = (currentTicketView === 'pending');

        // Se a mensagem for do ticket ativo, adiciona ela ao chat
        if (data.ticket_id == activeTicketId) {
            renderMessage(data);
            // Scroll para o final do chat
            chatBody.scrollTop = chatBody.scrollHeight;
        }

        // Gerencia notificações visuais: se for mensagem de contato e NÃO for o ticket ativo, incrementa contador
        try {
            if (data && data.sender === 'contact' && String(data.ticket_id) !== String(activeTicketId)) {
                // FILTRO: só incrementa se o agente tem permissão para ver este ticket
                let shouldNotify = false;
                
                // Admin/Supervisor vê tudo
                const isPrivileged = currentUser && (String(currentUser.profile).toLowerCase() === 'admin' || String(currentUser.profile).toLowerCase() === 'supervisor');
                if (isPrivileged) {
                    shouldNotify = true;
                } else if (currentUser && currentUser.id) {
                    // Se o ticket está atribuído ao usuário atual, notifica
                    if (data.ticket_user_id && data.ticket_user_id == currentUser.id) {
                        shouldNotify = true;
                    } 
                    // Se o ticket tem fila, verifica se está nas filas do usuário
                    else if (data.queue_id && currentUser.queue_ids && Array.isArray(currentUser.queue_ids)) {
                        const userQueueIds = currentUser.queue_ids.map(q => Number(q));
                        if (userQueueIds.includes(Number(data.queue_id))) {
                            shouldNotify = true;
                        }
                    }
                    // Se o ticket não tem fila nem usuário atribuído, notifica agentes que têm filas
                    else if (!data.queue_id && !data.ticket_user_id && currentUser.queue_ids && currentUser.queue_ids.length > 0) {
                        shouldNotify = true;
                    }
                }
                
                if (shouldNotify) {
                    // Adiciona à dropdown de notificações
                    addNotificationItem(data);
                    setNotificationsCount((notificationsCount || 0) + 1);
                    // Mostra notificação desktop e toca som
                    try {
                        const title = data.contact_name ? `${data.contact_name}` : 'Nova mensagem';
                        const snippet = data.last_message || data.body || '';
                        showDesktopNotification({ title: `📩 ${title}`, body: snippet.substring(0, 120), ticketId: data.ticket_id });
                        playBeep();
                    } catch (e) { console.warn('Erro ao mostrar notificação desktop:', e); }
                }
            }
        } catch (e) { console.warn('Erro ao processar notificação de nova mensagem', e); }
        
        // Atualiza a lista de tickets para refletir a última mensagem
        try {
            const ticketEl = ticketListContainer.querySelector(`[data-ticket-id='${data.ticket_id}']`);
            
            // Se o ticket estiver visível na lista, atualiza o badge de mensagens não lidas
            if (ticketEl && String(data.ticket_id) !== String(activeTicketId)) {
                // Atualiza snippet da última mensagem
                const snippetEl = ticketEl.querySelector('.ticket-info-content p.text-muted');
                if (snippetEl) {
                    snippetEl.textContent = (data.body || '').slice(0, 140);
                }
                
                // Atualiza ou cria badge de mensagens não lidas ao lado do protocolo
                let badgeEl = ticketEl.querySelector('.badge.bg-success.rounded-pill');
                if (badgeEl) {
                    // Badge já existe - incrementa contador
                    const current = Number(badgeEl.textContent || 0) || 0;
                    badgeEl.textContent = String(current + 1);
                    badgeEl.classList.remove('d-none');
                } else {
                    // Badge não existe - cria novo ao lado do protocolo
                    const ticketContent = ticketEl.querySelector('.ticket-info-content');
                    if (ticketContent) {
                        // Procura o elemento do protocolo
                        const protocolEl = ticketContent.querySelector('p.text-primary');
                        if (protocolEl) {
                            // Adiciona badge flutuante ao lado do protocolo
                            badgeEl = document.createElement('span');
                            badgeEl.className = 'badge bg-success rounded-pill position-absolute top-0 start-100 translate-middle ms-1';
                            badgeEl.style.fontSize = '0.65rem';
                            badgeEl.textContent = '1';
                            protocolEl.appendChild(badgeEl);
                        }
                    }
                }
            }
            
            const localWasPending = ticketEl && ticketEl.getAttribute('data-status') === 'pending';
            if (wasViewingPendingBefore && localWasPending && ticketEl) {
                // Se estamos na visão pendente e atualizamos o ticket localmente, não recarrega a lista
                return;
            }
            
            // Se conseguimos atualizar o ticket localmente (badge adicionado/incrementado), não recarrega
            if (ticketEl) {
                return;
            }
        } catch (e) { console.warn('Erro ao atualizar badge do ticket após new-message', e); }

        loadTickets().catch(e => { console.warn('Erro ao recarregar tickets após new-message', e); });
    });

    // Atualizações parciais de mensagens (ex: marcação como entregue)
    socket.on('message_update', (data) => {
        console.log('Atualização de mensagem recebida:', data);
        try {
            if (!data || !data.id) return;
            const el = chatBody.querySelector(`[data-message-id="${data.id}"]`);
            if (!el) return;
            const badge = el.querySelector('.badge');
            if (!badge) return;
            if (data.delivered === 1 || data.delivered === true) {
                badge.className = 'badge bg-success me-1';
                badge.textContent = '✔✔';
            } else if (data.sent_via_whatsapp === 1 || data.sent_via_whatsapp === true) {
                badge.className = 'badge bg-info text-dark me-1';
                badge.textContent = '✔';
            } else {
                badge.className = 'badge bg-warning text-dark me-1';
                badge.textContent = 'Pendente';
            }
        } catch (e) { console.warn('Erro ao aplicar message_update:', e); }
    });

    socket.on('connection_update', async (data) => {
        console.log('Atualização de conexão recebida:', data);

        // Se a conexão foi estabelecida com sucesso, fecha o modal do QR Code se ele estiver aberto para essa conexão.
        try {
            const incomingId = typeof data.id !== 'undefined' && data.id !== null ? Number(data.id) : null;
            const activeId = typeof activeQrConnectionId !== 'undefined' && activeQrConnectionId !== null ? Number(activeQrConnectionId) : null;
            if (data.status === 'CONNECTED' && incomingId && activeId && incomingId === activeId) {
                // Fecha o modal do QR Code automaticamente quando a sessão conectar.
                try {
                    if (qrCodeModal) qrCodeModal.hide();
                } catch (e) { /* ignore */ }
                // Limpa a UI do QR e o estado local
                const qrContainer = document.getElementById('qrcode-container');
                if (qrContainer) qrContainer.innerHTML = '';
                activeQrConnectionId = null; // Limpa o ID ativo
                // Cancela qualquer polling pendente para essa conexão
                try {
                    if (qrPollingIntervals && qrPollingIntervals[incomingId]) {
                        clearInterval(qrPollingIntervals[incomingId]);
                        delete qrPollingIntervals[incomingId];
                    }
                } catch (e) { /* ignore */ }
                showNotification('Conexão estabelecida! O modal do QR Code foi fechado automaticamente.', 'success');
            }
        } catch (e) {
            console.warn('Erro ao processar connection_update para fechar modal QR:', e);
        }

        // Fallback adicional: se o modal do QR estiver aberto (o usuário pode ter fechado/reaberto
        // ou perdido o activeQrConnectionId), e qualquer conexão se tornar CONNECTED, fecha o modal.
        try {
            if (data.status === 'CONNECTED') {
                const modalEl = document.getElementById('qrCodeModal');
                const qrContainer = document.getElementById('qrcode-container');
                const modalIsOpen = modalEl && modalEl.classList && modalEl.classList.contains('show');
                const hasQr = qrContainer && (qrContainer.querySelector('img') || qrContainer.querySelector('.spinner-border'));
                if (modalIsOpen && hasQr) {
                    try { if (qrCodeModal) qrCodeModal.hide(); } catch (e) { /* ignore */ }
                    if (qrContainer) qrContainer.innerHTML = '';
                    activeQrConnectionId = null;
                    try { if (qrPollingIntervals && qrPollingIntervals[data.id]) { clearInterval(qrPollingIntervals[data.id]); delete qrPollingIntervals[data.id]; } } catch (e) {}
                    console.info('QR modal fechado por fallback após connection_update CONNECTED (fallback).');
                    showNotification('Conexão estabelecida! O modal do QR Code foi fechado automaticamente.', 'success');
                }
            }
        } catch (e) { /* ignore */ }

        // Para qualquer atualização de status (CONNECTED, DISCONNECTED, etc.), recarrega a lista inteira de conexões.
        // Isso garante que a tabela sempre reflita o estado mais recente.
        loadConnections();
    });

    // --- INICIALIZAÇÃO ---

    // === FUNÇÕES DE CHATBOT ===

    // Salva a configuração do chatbot
    async function saveChatbotConfig() {
        const welcome_message = chatbotConfigForm.welcome_message.value.trim();
        const queue_selection_message = chatbotConfigForm.queue_selection_message.value.trim();
        const waiting_message = chatbotConfigForm.waiting_message.value.trim();
        const thank_you_message = chatbotConfigForm.thank_you_message.value.trim();
        const feedback_message = chatbotConfigForm.feedback_message.value.trim();

        // Validação básica
        if (!welcome_message || !queue_selection_message || !waiting_message || !thank_you_message || !feedback_message) {
            showNotification('Todos os campos são obrigatórios.', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/chatbot/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    welcome_message,
                    queue_selection_message,
                    waiting_message,
                    thank_you_message,
                    feedback_message
                })
            });

            if (!response.ok) throw new Error('Falha ao salvar configuração do chatbot.');

            chatbotConfigModal.hide();
            showNotification('Configuração do chatbot salva com sucesso!', 'success');
        } catch (error) {
            showNotification(`Erro: ${error.message}`, 'danger');
        }
    }

    // Carrega as filas nos modais uma vez na inicialização
    populateQueueCheckboxes();

    // Ligações dos botões de filtro do Painel
    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', (e) => {
            e.preventDefault();
            updateDashboardStats();
        });
    }
    if (clearFiltersButton) {
        clearFiltersButton.addEventListener('click', (e) => {
            e.preventDefault();
            if (filterDateStartInput) filterDateStartInput.value = '';
            if (filterDateEndInput) filterDateEndInput.value = '';
            if (filterUserSelect) filterUserSelect.value = '';
            updateDashboardStats();
        });
    }
    if (exportPdfButton) {
        exportPdfButton.addEventListener('click', (e) => {
            e.preventDefault();
            exportDashboardToPDF();
        });
    }

    initializeChart();

    // Inicializa sempre em "Atendimentos" (ingressos) ao carregar o sistema
    navigateTo('ingressos');

    // Restaura estado salvo (view, sub-aba e ticket ativo) após inicialização básica
    (function restoreUI(){
        try {
            const saved = lsGetJSON('chat_state', {});
            if (!saved) return;
            // Se a seção salva não for painel, já está navegada acima
            // Ajusta abas internas de tickets somente se estivermos em uma seção que contém tickets
            if (currentSection === 'ingressos' || currentSection === 'painel') {
            // Se view não for painel padrão 'inbox'
            if (saved.currentTicketView === 'resolved') {
                const btn = document.getElementById('nav-resolved');
                // manter comportamento anterior: navegar para resolvidos
                if (btn) btn.click();
            } else if (saved.currentTicketView === 'pending') {
                // Use a função segura que altera a tab Pendente sem disparar handlers indesejados
                try { selectTabPendente(); } catch(e) { const tp = document.getElementById('tab-pendente'); if (tp) tp.click(); }
            } else {
                // inbox: restaura sub-aba usando helpers seguros
                if (saved.currentTicketStatus === 'pending') {
                    try { selectSubtabPending(); } catch(e) { const ta = document.getElementById('tab-aguardando'); if (ta) ta.click(); }
                } else {
                    try { selectSubtabAtendendo(); } catch(e) { const tt = document.getElementById('tab-atendendo'); if (tt) tt.click(); }
                }
            }
            }
            if (saved.activeTicketId) {
                setTimeout(()=>{ loadChat(saved.activeTicketId); }, 400);
            }
        } catch(e){ console.warn('Falha ao restaurar estado', e); }
    })();

    // --- PERFIL DO USUÁRIO ---
    (function loadUserProfile(){
        const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
        console.log('[loadUserProfile] currentUser from localStorage:', currentUser);
        if (!currentUser.id) {
            console.warn('[loadUserProfile] Nenhum currentUser encontrado no localStorage. Perfil não será carregado.');
            return;
        }

        // Atualizar botão do perfil com nome do usuário
        const profileBtn = document.getElementById('profile-username-button');
        if (profileBtn && currentUser.name) {
            profileBtn.textContent = currentUser.name;
        }

        // Carregar detalhes do perfil
        const url = '/api/users/' + currentUser.id;
        console.log('[loadUserProfile] fetching', url);
        fetch(url)
            .then(r => {
                if (!r.ok) {
                    console.error('[loadUserProfile] resposta não ok', r.status);
                }
                return r.json();
            })
            .then(data => {
                console.log('[loadUserProfile] fetch result:', data);
                // Atualizar nome
                const nameDisplay = document.getElementById('profile-name-display');
                if (nameDisplay) {
                    nameDisplay.textContent = data.name || '-';
                }

                // Atualizar email
                const emailDisplay = document.getElementById('profile-email-display');
                if (emailDisplay) {
                    emailDisplay.textContent = data.email || '-';
                }

                // Atualizar filas
                const queuesDisplay = document.getElementById('profile-queues-display');
                if (queuesDisplay) {
                    const renderQueues = (names) => {
                        queuesDisplay.textContent = names && names.length > 0 ? names.join(', ') : 'Nenhuma fila atribuída';
                    };

                    if (data.queues && data.queues.length > 0) {
                        renderQueues(data.queues.map(q => q.name));
                    } else if (Array.isArray(data.queue_ids) && data.queue_ids.length > 0) {
                        // Buscar nomes das filas a partir de queue_ids
                        fetch('/api/queues')
                            .then(r => r.json())
                            .then(allQueues => {
                                const ids = data.queue_ids.map(Number);
                                const names = allQueues
                                    .filter(q => ids.includes(Number(q.id)))
                                    .map(q => q.name);
                                renderQueues(names);
                            })
                            .catch(() => renderQueues([]));
                    } else {
                        // Último fallback: localStorage
                        const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
                        const userQueueIds = (currentUser.queue_ids || []).map(Number);
                        if (userQueueIds.length > 0) {
                            fetch('/api/queues')
                                .then(r => r.json())
                                .then(allQueues => {
                                    const names = allQueues
                                        .filter(q => userQueueIds.includes(Number(q.id)))
                                        .map(q => q.name);
                                    renderQueues(names);
                                })
                                .catch(() => renderQueues([]));
                        } else {
                            renderQueues([]);
                        }
                    }
                }
            })
            .catch(err => {
                console.error('Erro ao carregar perfil:', err);
                // Fallback: tentar compor as filas a partir do localStorage e da lista global de filas
                const queuesDisplay = document.getElementById('profile-queues-display');
                if (queuesDisplay) {
                    const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
                    const userQueueIds = currentUser.queue_ids || [];
                    if (Array.isArray(userQueueIds) && userQueueIds.length > 0) {
                        fetch('/api/queues')
                            .then(r => r.json())
                            .then(allQueues => {
                                const names = allQueues
                                    .filter(q => userQueueIds.includes(q.id))
                                    .map(q => q.name);
                                queuesDisplay.textContent = names.length > 0 ? names.join(', ') : 'Nenhuma fila atribuída';
                            })
                            .catch(() => {
                                queuesDisplay.textContent = 'Nenhuma fila atribuída';
                            });
                    } else {
                        queuesDisplay.textContent = 'Nenhuma fila atribuída';
                    }
                }
            });

        // Botão para alterar senha
        const changePasswordBtn = document.getElementById('change-password-button');
        if (changePasswordBtn) {
            changePasswordBtn.addEventListener('click', function(e) {
                e.preventDefault();
                const changePasswordModal = new bootstrap.Modal(document.getElementById('changePasswordModal'));
                changePasswordModal.show();
            });
        }

        // Formulário de alteração de senha
        const confirmChangePasswordBtn = document.getElementById('confirm-change-password-button');
        if (confirmChangePasswordBtn) {
            confirmChangePasswordBtn.addEventListener('click', function() {
                const currentPassword = document.getElementById('current-password').value;
                const newPassword = document.getElementById('new-password').value;
                const confirmPassword = document.getElementById('confirm-new-password').value;

                // Validações
                if (!currentPassword || !newPassword || !confirmPassword) {
                    showNotification('Por favor, preencha todos os campos.', 'warning');
                    return;
                }

                if (newPassword.length < 6) {
                    showNotification('A nova senha deve ter pelo menos 6 caracteres.', 'warning');
                    return;
                }

                if (newPassword !== confirmPassword) {
                    showNotification('A nova senha e a confirmação não coincidem.', 'warning');
                    return;
                }

                // Enviar para o backend
                fetch('/api/users/' + currentUser.id + '/password', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        currentPassword: currentPassword,
                        newPassword: newPassword
                    })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        showNotification('Senha alterada com sucesso!', 'success');
                        const changePasswordModal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
                        changePasswordModal.hide();
                        // Limpar campos
                        document.getElementById('current-password').value = '';
                        document.getElementById('new-password').value = '';
                        document.getElementById('confirm-new-password').value = '';
                    } else {
                        showNotification(data.message || 'Erro ao alterar senha.', 'danger');
                    }
                })
                .catch(err => {
                    console.error('Erro ao alterar senha:', err);
                    showNotification('Erro ao alterar senha. Tente novamente.', 'danger');
                });
            });
        }
    })();

    // --- EMOJI PICKER ---
    (function initEmojiPicker(){
        const emojiBtn = document.getElementById('emoji-button');
        const input = document.getElementById('chat-message-input');
        if (!emojiBtn || !input) return;
        if (emojiBtn.dataset.initialized) return;
        emojiBtn.dataset.initialized = 'true';

        let pickerWrapper = null;
        let isOpen = false;

        function closePicker(){
            if (pickerWrapper){
                pickerWrapper.remove();
                pickerWrapper = null;
            }
            isOpen = false;
            document.removeEventListener('click', outsideHandler, true);
        }

        function outsideHandler(ev){
            if (!pickerWrapper) return;
            if (!pickerWrapper.contains(ev.target) && ev.target !== emojiBtn){
                closePicker();
            }
        }

        function openPicker(){
            if (isOpen){ closePicker(); return; }
            pickerWrapper = document.createElement('div');
            pickerWrapper.style.position = 'absolute';
            pickerWrapper.style.zIndex = '1080';
            pickerWrapper.style.bottom = '55px';
            pickerWrapper.style.left = '10px';
            pickerWrapper.style.width = '320px';
            pickerWrapper.style.maxHeight = '360px';
            pickerWrapper.style.overflow = 'hidden';
            pickerWrapper.className = 'card shadow border-0';
            pickerWrapper.innerHTML = '<div class="card-body p-0" style="max-height:360px;overflow:auto;"><emoji-picker style="width:100%;"></emoji-picker></div>';
            const footer = document.getElementById('chat-footer') || emojiBtn.closest('#chat-footer');
            (footer || document.body).appendChild(pickerWrapper);
            isOpen = true;
            document.addEventListener('click', outsideHandler, true);
            const pickerEl = pickerWrapper.querySelector('emoji-picker');
            if (pickerEl){
                pickerEl.addEventListener('emoji-click', (e)=>{
                    const emoji = e.detail?.unicode || e.detail?.emoji;
                    if (emoji){
                        const start = input.selectionStart ?? input.value.length;
                        const end = input.selectionEnd ?? input.value.length;
                        input.value = input.value.slice(0,start) + emoji + input.value.slice(end);
                        const newPos = start + emoji.length;
                        input.focus();
                        input.setSelectionRange(newPos,newPos);
                    }
                });
            }
        }

        emojiBtn.addEventListener('click', (e)=>{
            e.preventDefault();
            openPicker();
        });
    })();

    // Funções para Chat Interno
    async function loadOnlineUsers() {
        try {
            const response = await fetch('/api/users/online');
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error('Falha ao buscar /api/users/online', response.status, errText);
                throw new Error('Erro ao carregar usuários online');
            }
            
            const users = await response.json();
            const onlineUsersList = document.getElementById('online-users-list');
            
            onlineUsersList.innerHTML = '';
            
            // Armazena IDs dos usuários online globalmente
            window.onlineUserIds = users.map(u => u.id);
            
            users.forEach(user => {
                if (user.id !== currentUser.id) { // Não mostrar o próprio usuário
                    const userItem = createUserListItem(user, true);
                    // Restaura seleção se este for o usuário selecionado
                    if (window.selectedChatUser && window.selectedChatUser.id === user.id) {
                        userItem.classList.add('active');
                    }
                    onlineUsersList.appendChild(userItem);
                }
            });
            
            if (users.filter(u => u.id !== currentUser.id).length === 0) {
                onlineUsersList.innerHTML = '<div class="p-3 text-center text-muted">Nenhum usuário online</div>';
            }
        } catch (error) {
            console.error('Erro ao carregar usuários online:', error);
            document.getElementById('online-users-list').innerHTML = '<div class="p-3 text-center text-danger">Erro ao carregar usuários</div>';
        }
    }
    
    // Função para carregar usuários offline
    async function loadOfflineUsers() {
        try {
            const response = await fetch('/api/users');
            if (!response.ok) throw new Error('Erro ao carregar usuários');
            
            const allUsers = await response.json();
            const offlineUsersList = document.getElementById('offline-users-list');
            
            // Filtra apenas usuários que não estão online
            const offlineUsers = allUsers.filter(user => 
                user.id !== currentUser.id && 
                !window.onlineUserIds.includes(user.id)
            );
            
            offlineUsersList.innerHTML = '';
            
            if (offlineUsers.length === 0) {
                offlineUsersList.innerHTML = '<div class="p-3 text-center text-muted">Nenhum usuário offline</div>';
                return;
            }
            
            offlineUsers.forEach(user => {
                const userItem = createUserListItem(user, false);
                // Restaura seleção se este for o usuário selecionado
                if (window.selectedChatUser && window.selectedChatUser.id === user.id) {
                    userItem.classList.add('active');
                }
                offlineUsersList.appendChild(userItem);
            });
            
        } catch (error) {
            console.error('Erro ao carregar usuários offline:', error);
        }
    }
    
    // Função para carregar todos os usuários
    async function loadAllUsers() {
        try {
            const response = await fetch('/api/users');
            if (!response.ok) throw new Error('Erro ao carregar usuários');
            
            const allUsers = await response.json();
            const onlineUsersList = document.getElementById('online-users-list');
            const offlineUsersList = document.getElementById('offline-users-list');
            
            const onlineUsers = allUsers.filter(user => 
                user.id !== currentUser.id && 
                window.onlineUserIds && window.onlineUserIds.includes(user.id)
            );
            
            const offlineUsers = allUsers.filter(user => 
                user.id !== currentUser.id && 
                (!window.onlineUserIds || !window.onlineUserIds.includes(user.id))
            );
            
            // Preenche lista de online
            onlineUsersList.innerHTML = '';
            onlineUsers.forEach(user => {
                const userItem = createUserListItem(user, true);
                // Restaura seleção se este for o usuário selecionado
                if (window.selectedChatUser && window.selectedChatUser.id === user.id) {
                    userItem.classList.add('active');
                }
                onlineUsersList.appendChild(userItem);
            });
            if (onlineUsers.length === 0) {
                onlineUsersList.innerHTML = '<div class="p-3 text-center text-muted">Nenhum usuário online</div>';
            }
            
            // Preenche lista de offline
            offlineUsersList.innerHTML = '';
            offlineUsers.forEach(user => {
                const userItem = createUserListItem(user, false);
                // Restaura seleção se este for o usuário selecionado
                if (window.selectedChatUser && window.selectedChatUser.id === user.id) {
                    userItem.classList.add('active');
                }
                offlineUsersList.appendChild(userItem);
            });
            if (offlineUsers.length === 0) {
                offlineUsersList.innerHTML = '<div class="p-3 text-center text-muted">Nenhum usuário offline</div>';
            }
            
        } catch (error) {
            console.error('Erro ao carregar todos os usuários:', error);
        }
    }
    
    // Função auxiliar para criar item de usuário na lista
    // Contadores de não lidas por usuário
    if (!window.unreadCounts) window.unreadCounts = {};

    // Busca contadores de não lidas do backend e atualiza badges
    async function fetchUnreadCounts() {
        try {
            if (!currentUser) return;
            const response = await fetch(`/api/chat/unread-counts?userId=${currentUser.id}`);
            if (!response.ok) throw new Error('Erro ao carregar contadores de não lidas');
            const rows = await response.json();
            const prev = window.unreadCounts || {};
            const next = {};
            rows.forEach(r => { next[r.user_id] = r.count; });
            // Preenche com zero onde não retornou nada, mantendo apenas os usuários com badge visível antes
            const idsToUpdate = new Set([...Object.keys(prev), ...Object.keys(next)]);
            window.unreadCounts = next;
            idsToUpdate.forEach(id => updateUnreadBadgeFor(Number(id)));
            // Atualiza indicador visual no menu após buscar contadores
            updateChatInternoMenuNotification();
        } catch (error) {
            console.error('Erro ao buscar contadores de não lidas:', error);
        }
    }

    // Reseta a área de chat para o estado padrão (sem usuário selecionado)
    function resetChatArea() {
        // Remove seleção de todos os usuários
        document.querySelectorAll('#online-users-list .list-group-item, #offline-users-list .list-group-item, #all-users-list .list-group-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Limpa o usuário selecionado
        window.selectedChatUser = null;
        
        // Restaura cabeçalho padrão
        document.getElementById('chat-header-title').innerHTML = `
            <i class="bi bi-chat-dots me-2"></i>Selecione um usuário para conversar
        `;
        
        // Restaura status padrão
        const statusBadge = document.getElementById('chat-status');
        statusBadge.textContent = 'Offline';
        statusBadge.className = 'badge bg-secondary';
        
    // Desabilita input de mensagem (chat interno)
    const messageInput = document.getElementById('internal-chat-message-input');
    const sendBtn = document.getElementById('internal-send-message-btn');
    if (messageInput) { messageInput.disabled = true; messageInput.placeholder = 'Digite sua mensagem...'; messageInput.value = ''; }
    if (sendBtn) sendBtn.disabled = true;
        
        // Restaura mensagem padrão na área de chat
        const chatMessages = document.getElementById('chat-messages');
        chatMessages.innerHTML = `
            <div class="text-center text-muted">
                <i class="bi bi-chat-dots-fill display-1"></i>
                <p>Escolha um usuário na lista ao lado para iniciar uma conversa</p>
            </div>
        `;
    }

    function createUserListItem(user, isOnline) {
        const userItem = document.createElement('div');
        userItem.className = 'list-group-item list-group-item-action d-flex align-items-center';
        userItem.style.cursor = 'pointer';
        userItem.setAttribute('data-user-id', user.id);
        const unreadCount = window.unreadCounts[user.id] || 0;
        userItem.innerHTML = `
            <div class="me-3">
                <div class="bg-${isOnline ? 'success' : 'secondary'} rounded-circle" style="width: 10px; height: 10px;"></div>
            </div>
            <div class="flex-grow-1">
                <div class="fw-semibold d-flex align-items-center">
                    <span>${user.name}</span>
                    <span class="badge bg-danger ms-2 unread-badge" data-user-id="${user.id}" style="${unreadCount > 0 ? '' : 'display:none;'}">${unreadCount}</span>
                </div>
            </div>
        `;
        
        userItem.addEventListener('click', () => selectChatUser(user, isOnline));
        return userItem;
    }

    // Atualiza/mostra o badge de não lidas ao lado do nome
    function updateUnreadBadgeFor(userId) {
        const count = window.unreadCounts[userId] || 0;
        // Atualiza todos os badges do usuário nas três listas (online/offline/todos)
            // Só tenta atualizar se os badges existirem na DOM (quando estiver no Chat Interno)
        document.querySelectorAll(`.unread-badge[data-user-id="${userId}"]`).forEach(badge => {
            if (count > 0) {
                badge.textContent = count;
                badge.style.display = '';
            } else {
                badge.textContent = '';
                badge.style.display = 'none';
            }
        });
        // Atualiza indicador visual no menu Chat Interno
            // (funciona independente de estar ou não no Chat Interno)
        updateChatInternoMenuNotification();
    }

    // Atualiza indicador visual (piscada) no botão do menu Chat Interno
    function updateChatInternoMenuNotification() {
        const totalUnread = Object.values(window.unreadCounts || {}).reduce((sum, count) => sum + count, 0);
        const menuChatInternoBtn = document.getElementById('menu-chat-interno');
        if (menuChatInternoBtn) {
            if (totalUnread > 0) {
                menuChatInternoBtn.classList.add('chat-interno-notification');
            } else {
                menuChatInternoBtn.classList.remove('chat-interno-notification');
            }
        }
    }
    
    // Função para buscar todos os usuários
    async function searchAllUsers(query) {
        try {
            const response = await fetch('/api/users');
            if (!response.ok) throw new Error('Erro ao carregar usuários');
            
            const users = await response.json();
            const allUsersList = document.getElementById('all-users-list');
            const allUsersSection = document.getElementById('all-users-section');
            
            // Filtra usuários com base na busca
            const filteredUsers = users.filter(user => 
                user.id !== currentUser.id && 
                (user.name.toLowerCase().includes(query.toLowerCase()) || 
                 user.email.toLowerCase().includes(query.toLowerCase()))
            );
            
            if (query.trim() === '') {
                // Se não há busca, esconde a seção de todos os usuários
                allUsersSection.classList.add('d-none');
                return;
            }
            
            allUsersSection.classList.remove('d-none');
            allUsersList.innerHTML = '';
            
            if (filteredUsers.length === 0) {
                allUsersList.innerHTML = '<div class="p-3 text-center text-muted">Nenhum usuário encontrado</div>';
                return;
            }
            
            filteredUsers.forEach(user => {
                const isOnline = window.onlineUserIds && window.onlineUserIds.includes(user.id);
                const userItem = createUserListItem(user, isOnline);
                allUsersList.appendChild(userItem);
            });
            
        } catch (error) {
            console.error('Erro ao buscar usuários:', error);
        }
    }
    
    // Event listener para busca de usuários
    const searchUsersInput = document.getElementById('search-users-input');
    if (searchUsersInput) {
        searchUsersInput.addEventListener('input', (e) => {
            const query = e.target.value;
            // Reseta o chat ao mudar a busca
            resetChatArea();
            if (query.trim() !== '') {
                // Se está buscando, mostra os resultados
                document.getElementById('online-section').classList.add('d-none');
                document.getElementById('offline-section').classList.add('d-none');
                searchAllUsers(query);
            } else {
                // Se não está buscando, volta ao filtro selecionado
                document.getElementById('all-users-section').classList.add('d-none');
                applyUserFilter();
            }
        });
    }

    // Busca local de contatos (nome ou número)
    const contactSearchInput = document.getElementById('contact-search-input');
    // contactSearchStatusEl removed (debug UI cleared)
    let contactSearchStatusEl = null;
    // Centraliza lógica de busca para ser usada por listener direto e delegação
    let contactSearchTimer = null;
    function handleContactSearch(raw) {
        if (contactSearchTimer) clearTimeout(contactSearchTimer);
        contactSearchTimer = setTimeout(() => {
            try {
                const q = (raw || '').trim().toLowerCase();
                console.debug('[contacts] search input:', q);
                if (q === '') {
                    renderContacts(contactsCache);
                    console.debug('[contacts] rendered full list, total=', (contactsCache||[]).length);
                    return;
                }
                // normalize removes case and diacritics for more robust matching
                const normalize = (s='') => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                // Filter by name only (ignore phone)
                const filtered = (contactsCache || []).filter(c => {
                    const name = normalize(c.name || '');
                    return name.includes(q);
                });
                console.debug('[contacts] filtered count=', filtered.length);
                renderContacts(filtered);
            } catch (err) {
                console.error('[contacts] search error', err);
            }
        }, 150);
    }

    if (contactSearchInput) {
        contactSearchInput.addEventListener('input', (e) => handleContactSearch(e.target.value));
    }

    // Log de inicialização para depuração
    console.debug('[dashboard] contactSearchInput present?', !!contactSearchInput);

    // Tornar o ícone de lupa clicável: foca o input correspondente e dispara o input
    document.querySelectorAll('.input-group .input-group-text').forEach(el => {
        try {
            if (el.querySelector('.bi-search')) {
                el.style.cursor = 'pointer';
                el.addEventListener('click', (ev) => {
                    // Tenta encontrar um input dentro do same .input-group
                    const parent = el.closest('.input-group');
                    if (!parent) return;
                    const input = parent.querySelector('input');
                    if (!input) return;
                    input.focus();
                    // dispara evento de input para acionar busca (se já houver texto)
                    input.dispatchEvent(new Event('input'));
                });
            }
        } catch (e) { /* ignore */ }
    });

    // Delegated listener (fallback) - captura caso o input seja recriado dinamicamente
    document.addEventListener('input', (e) => {
        if (!e || !e.target) return;
        if (e.target.id === 'contact-search-input') {
            handleContactSearch(e.target.value);
        }
    });

    // contacts loaded UI hook removed (debug status cleared)
    
    // Event listeners para os filtros
    const filterAll = document.getElementById('filter-all');
    const filterOnline = document.getElementById('filter-online');
    const filterOffline = document.getElementById('filter-offline');
    
    if (filterAll) {
        filterAll.addEventListener('change', () => {
            if (filterAll.checked) {
                resetChatArea();
                applyUserFilter('all');
            }
        });
    }
    
    if (filterOnline) {
        filterOnline.addEventListener('change', () => {
            if (filterOnline.checked) {
                resetChatArea();
                applyUserFilter('online');
            }
        });
    }
    
    if (filterOffline) {
        filterOffline.addEventListener('change', () => {
            if (filterOffline.checked) {
                resetChatArea();
                applyUserFilter('offline');
            }
        });
    }
    
    // Função para aplicar filtro de usuários
    function applyUserFilter(filter) {
        // Se não especificado, pega o filtro selecionado
        if (!filter) {
            if (document.getElementById('filter-all').checked) filter = 'all';
            else if (document.getElementById('filter-online').checked) filter = 'online';
            else if (document.getElementById('filter-offline').checked) filter = 'offline';
        }
        
        const onlineSection = document.getElementById('online-section');
        const offlineSection = document.getElementById('offline-section');
        const allUsersSection = document.getElementById('all-users-section');
        
        // Esconde a seção de busca
        allUsersSection.classList.add('d-none');
        
        if (filter === 'all') {
            onlineSection.classList.remove('d-none');
            offlineSection.classList.remove('d-none');
            loadAllUsers();
        } else if (filter === 'online') {
            onlineSection.classList.remove('d-none');
            offlineSection.classList.add('d-none');
            loadOnlineUsers();
        } else if (filter === 'offline') {
            onlineSection.classList.add('d-none');
            offlineSection.classList.remove('d-none');
            loadOfflineUsers();
        }
    }
    
    function selectChatUser(user, isOnline) {
        // Remove seleção anterior de todas as listas
        document.querySelectorAll('#online-users-list .list-group-item, #offline-users-list .list-group-item, #all-users-list .list-group-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Adiciona seleção ao usuário clicado
        event.target.closest('.list-group-item').classList.add('active');
        
        // Atualiza cabeçalho do chat
        document.getElementById('chat-header-title').innerHTML = `
            <i class="bi bi-chat-dots me-2"></i>Conversando com ${user.name}
        `;
        
        // Define status baseado se está online ou não
        const statusBadge = document.getElementById('chat-status');
        if (isOnline) {
            statusBadge.textContent = 'Online';
            statusBadge.className = 'badge bg-success';
        } else {
            statusBadge.textContent = 'Offline';
            statusBadge.className = 'badge bg-secondary';
        }
        
    // Habilita input de mensagem (chat interno)
    const messageInput = document.getElementById('internal-chat-message-input');
    const sendBtn = document.getElementById('internal-send-message-btn');
    if (messageInput) messageInput.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
        
        // Zera contadores de não lidas para este usuário e atualiza badges
        if (!window.unreadCounts) window.unreadCounts = {};
        window.unreadCounts[user.id] = 0;
        if (typeof updateUnreadBadgeFor === 'function') {
            updateUnreadBadgeFor(user.id);
        }
        messageInput.placeholder = `Digite uma mensagem para ${user.name}...`;
        
        // Armazena o usuário selecionado para chat
        window.selectedChatUser = user;
        
        // Carrega histórico de mensagens
        loadChatMessages(user.id);
        
        // Configura envio de mensagem
        setupChatMessageSending(user.id);
        setupInternalChatMessageSending(user.id);
    }
    
    // Restaura o estado do chat quando há usuário selecionado
    function restoreChatState() {
        if (!window.selectedChatUser) return;
        
        const user = window.selectedChatUser;
        
        // Remove seleção anterior de todas as listas
        document.querySelectorAll('#online-users-list .list-group-item, #offline-users-list .list-group-item, #all-users-list .list-group-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Tenta encontrar e selecionar o usuário na lista (será atualizado quando loadOnlineUsers rodar)
        const userElements = document.querySelectorAll(`[data-user-id="${user.id}"]`);
        userElements.forEach(element => {
            element.classList.add('active');
        });
        
        // Atualiza cabeçalho do chat
        document.getElementById('chat-header-title').innerHTML = `
            <i class="bi bi-chat-dots me-2"></i>Conversando com ${user.name}
        `;
        
        // Define status (assume offline por padrão, será atualizado quando loadOnlineUsers rodar)
        const statusBadge = document.getElementById('chat-status');
        statusBadge.textContent = 'Offline';
        statusBadge.className = 'badge bg-secondary';
        
        // Habilita input de mensagem
        const messageInput = document.getElementById('internal-chat-message-input');
        const sendBtn = document.getElementById('internal-send-message-btn');
        if (messageInput) {
            messageInput.disabled = false;
            messageInput.placeholder = `Digite uma mensagem para ${user.name}...`;
        }
        if (sendBtn) sendBtn.disabled = false;
        
        // Carrega histórico de mensagens
        loadChatMessages(user.id);
        
        // Configura envio de mensagem
        setupChatMessageSending(user.id);
        setupInternalChatMessageSending(user.id);
    }
    
    async function loadChatMessages(otherUserId) {
        try {
            const response = await fetch(`/api/chat/messages/${otherUserId}?userId=${currentUser.id}`);
            if (!response.ok) throw new Error('Erro ao carregar mensagens');
            
            const messages = await response.json();
            const chatMessages = document.getElementById('chat-messages');
            
            if (messages.length === 0) {
                chatMessages.innerHTML = `
                    <div class="text-center text-muted">
                        <i class="bi bi-chat-text display-4"></i>
                        <p>Início da conversa</p>
                        <small>Envie uma mensagem para começar!</small>
                    </div>
                `;
                return;
            }
            
            chatMessages.innerHTML = '';
            
            // Reverter a ordem para mostrar mensagens antigas primeiro
            messages.reverse().forEach(msg => {
                const isFromMe = msg.from_user_id === currentUser.id;
                const messageElement = document.createElement('div');
                messageElement.className = 'mb-3';
                messageElement.innerHTML = `
                    <div class="d-flex ${isFromMe ? 'justify-content-end' : 'justify-content-start'}">
                        <div class="${isFromMe ? 'bg-primary text-white' : 'bg-light'} rounded p-2" style="max-width: 70%;">
                            ${msg.message}
                            <div class="text-${isFromMe ? 'end' : 'start'}">
                                <small class="${isFromMe ? 'opacity-75' : 'text-muted'}">${new Date(msg.created_at).toLocaleTimeString()}</small>
                            </div>
                        </div>
                    </div>
                `;
                chatMessages.appendChild(messageElement);
            });
            
            chatMessages.scrollTop = chatMessages.scrollHeight;
            
            // Marca mensagens como lidas
            await fetch('/api/chat/messages/read', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, otherUserId: otherUserId })
            });
            
        } catch (error) {
            console.error('Erro ao carregar mensagens:', error);
        }
    }
    
    function setupChatMessageSending(userId) {
        const messageInput = document.getElementById('chat-message-input');
        const sendBtn = document.getElementById('send-message-btn');
        
        if (!sendBtn || !messageInput) return;
        // Remove listeners anteriores substituindo por clones
        const newSendBtn = sendBtn.cloneNode(true);
        sendBtn.parentNode.replaceChild(newSendBtn, sendBtn);

        const newMessageInput = messageInput.cloneNode(true);
        messageInput.parentNode.replaceChild(newMessageInput, messageInput);

        // Adiciona novos listeners
        newSendBtn.addEventListener('click', () => sendChatMessage(userId));
        newMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.shiftKey) {
                return; // allow newline insertion
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage(userId);
            }
        });
    }
    
    function setupInternalChatMessageSending(userId) {
        const messageInput = document.getElementById('internal-chat-message-input');
        const sendBtn = document.getElementById('internal-send-message-btn');
        
        if (!sendBtn || !messageInput) return;
        
        // Remove listeners anteriores substituindo por clones
        const newSendBtn = sendBtn.cloneNode(true);
        sendBtn.parentNode.replaceChild(newSendBtn, sendBtn);

        const newMessageInput = messageInput.cloneNode(true);
        messageInput.parentNode.replaceChild(newMessageInput, messageInput);

        // Adiciona novos listeners
        newSendBtn.addEventListener('click', () => sendChatMessage(userId));
        newMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage(userId);
            }
        });
    }
    
    async function sendChatMessage(toUserId) {
    const messageInput = document.getElementById('internal-chat-message-input');
        const message = messageInput.value.trim();
        
        if (!message) return;
        
        try {
            const response = await fetch('/api/chat/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    fromUserId: currentUser.id, 
                    toUserId: toUserId, 
                    message: message 
                })
            });
            
            if (!response.ok) throw new Error('Erro ao enviar mensagem');
            
            const newMessage = await response.json();
            
            // Adiciona mensagem ao chat
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages.innerHTML.includes('Início da conversa')) {
                chatMessages.innerHTML = '';
            }
            
            const messageElement = document.createElement('div');
            messageElement.className = 'mb-3';
            messageElement.innerHTML = `
                <div class="d-flex justify-content-end">
                    <div class="bg-primary text-white rounded p-2" style="max-width: 70%;">
                        ${message}
                        <div class="text-end">
                            <small class="opacity-75">${new Date().toLocaleTimeString()}</small>
                        </div>
                    </div>
                </div>
            `;
            
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            messageInput.value = '';
            
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error);
            showNotification('Erro ao enviar mensagem. Tente novamente.', 'danger');
        }
    }
    
    // Listener para receber mensagens em tempo real via Socket.io
    socket.on(`chat_message_${currentUser.id}`, (messageData) => {
        // Verifica se a mensagem é do usuário atualmente selecionado E se o Chat Interno está visível
        if (isChatInternoVisible() && window.selectedChatUser && messageData.from_user_id === window.selectedChatUser.id) {
            const chatMessages = document.getElementById('chat-messages');
            
            if (chatMessages.innerHTML.includes('Início da conversa')) {
                chatMessages.innerHTML = '';
            }
            
            const messageElement = document.createElement('div');
            messageElement.className = 'mb-3';
            messageElement.innerHTML = `
                <div class="d-flex justify-content-start">
                    <div class="bg-light rounded p-2" style="max-width: 70%;">
                        ${messageData.message}
                        <div class="text-start">
                            <small class="text-muted">${new Date(messageData.created_at).toLocaleTimeString()}</small>
                        </div>
                    </div>
                </div>
            `;
            
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            
            // Marca a mensagem como lida
            fetch('/api/chat/messages/read', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, otherUserId: messageData.from_user_id })
            });
        } else {
            // Incrementa contador de não lidas e atualiza badge / pisca do menu
            if (!window.unreadCounts) window.unreadCounts = {};
            const fromId = messageData.from_user_id;
            window.unreadCounts[fromId] = (window.unreadCounts[fromId] || 0) + 1;
            if (typeof updateUnreadBadgeFor === 'function') {
                updateUnreadBadgeFor(fromId);
            }
        }
    });

        // Inicia verificação global de notificações do Chat Interno (sempre ativo)
        // Busca contadores de não lidas a cada 30 segundos, independente da seção atual
        fetchUnreadCounts(); // Busca imediatamente
        const globalUnreadInterval = setInterval(fetchUnreadCounts, 30000); // 30 segundos

    // Fim DOMContentLoaded
});