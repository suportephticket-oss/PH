// Mapeamento de módulos com ícones e nomes amigáveis
const moduleInfo = {
    dashboard: { icon: 'fas fa-chart-line', name: 'Dashboard' },
    tickets: { icon: 'fas fa-ticket-alt', name: 'Tickets' },
    connections: { icon: 'fas fa-plug', name: 'Conexões WhatsApp' },
    users: { icon: 'fas fa-users', name: 'Gerenciar Usuários' },
    queues: { icon: 'fas fa-list-ul', name: 'Filas de Atendimento' },
    quick_responses: { icon: 'fas fa-comments', name: 'Respostas Rápidas' },
    internal_chat: { icon: 'fas fa-comment-dots', name: 'Chat Interno' },
    permissions: { icon: 'fas fa-shield-alt', name: 'Permissões' },
    reports: { icon: 'fas fa-file-alt', name: 'Relatórios' },
    delete_tickets: { icon: 'fas fa-trash-alt', name: 'Excluir Tickets' }
};

// Nomes amigáveis dos perfis
const profileNames = {
    admin: 'Administrador',
    supervisor: 'Supervisor',
    usuario: 'Usuário'
};

let permissionsData = {};
let originalPermissions = {};

// Carrega as permissões ao iniciar a página
document.addEventListener('DOMContentLoaded', () => {
    const sessionToken = localStorage.getItem('sessionToken');
    
    if (!sessionToken) {
        alert('Sessão expirada. Faça login novamente.');
        window.location.href = 'index.html';
        return;
    }

    // Verificar se o usuário é admin
    checkAdminAccess(sessionToken);
    
    loadPermissions();
});

// Verifica se o usuário tem permissão de admin
async function checkAdminAccess(sessionToken) {
    try {
        const response = await fetch(`/api/user-permissions?sessionToken=${sessionToken}`);
        
        if (!response.ok) {
            throw new Error('Não foi possível verificar permissões');
        }

        const data = await response.json();
        
        // Só admin pode acessar esta página
        if (data.profile !== 'admin') {
            alert('Acesso negado. Apenas administradores podem gerenciar permissões.');
            window.location.href = 'dashboard.html';
            return;
        }
    } catch (error) {
        console.error('Erro ao verificar acesso:', error);
        alert('Erro ao verificar permissões. Redirecionando...');
        window.location.href = 'dashboard.html';
    }
}

// Carrega todas as permissões do servidor
async function loadPermissions() {
    showLoading(true);

    try {
        const response = await fetch('/api/permissions');
        
        if (!response.ok) {
            throw new Error('Erro ao carregar permissões');
        }

        permissionsData = await response.json();
        originalPermissions = JSON.parse(JSON.stringify(permissionsData)); // Deep copy
        
        renderPermissions();
    } catch (error) {
        console.error('Erro ao carregar permissões:', error);
        alert('Erro ao carregar permissões. Tente novamente.');
    } finally {
        showLoading(false);
    }
}

// Renderiza as permissões na interface
function renderPermissions() {
    const container = document.getElementById('permissionsContent');
    container.innerHTML = '';

    // Ordem dos perfis
    const profileOrder = ['admin', 'supervisor', 'usuario'];

    profileOrder.forEach(profile => {
        if (!permissionsData[profile]) return;

        const section = createProfileSection(profile, permissionsData[profile]);
        container.appendChild(section);
    });
}

// Cria a seção de um perfil
function createProfileSection(profile, permissions) {
    const section = document.createElement('div');
    section.className = 'profile-section';
    section.id = `section-${profile}`;

    const isAdmin = profile === 'admin';
    const isCollapsed = profile !== 'supervisor'; // Supervisor aberto por padrão

    section.innerHTML = `
        <div class="profile-header ${profile} ${isCollapsed ? 'collapsed' : ''}" 
             onclick="toggleProfileSection('${profile}')">
            <div>
                <i class="fas fa-user-shield"></i>
                <span>${profileNames[profile]}</span>
            </div>
            <div style="display: flex; gap: 15px; align-items: center;">
                ${isAdmin ? '<span class="profile-badge">Permissões Bloqueadas</span>' : ''}
                <i class="fas fa-chevron-down collapse-icon"></i>
            </div>
        </div>
        <div class="profile-content" id="content-${profile}" style="display: ${isCollapsed ? 'none' : 'block'}">
            ${isAdmin ? createAdminWarning() : ''}
            <table class="permissions-table">
                <thead>
                    <tr>
                        <th style="width: 60%;">Módulo</th>
                        <th style="width: 40%;">Permissão de Acesso</th>
                    </tr>
                </thead>
                <tbody>
                    ${permissions.map(perm => createPermissionRow(profile, perm)).join('')}
                </tbody>
            </table>
        </div>
    `;

    return section;
}

// Cria aviso para perfil Admin
function createAdminWarning() {
    return `
        <div class="alert alert-warning">
            <i class="fas fa-lock"></i>
            <strong>Atenção:</strong> As permissões do perfil Administrador não podem ser modificadas por questões de segurança.
        </div>
    `;
}

// Cria uma linha de permissão
function createPermissionRow(profile, permission) {
    const isAdmin = profile === 'admin';
    const module = permission.module;
    const info = moduleInfo[module] || { icon: 'fas fa-cog', name: module };

    return `
        <tr>
            <td>
                <span class="module-name">
                    <i class="${info.icon} module-icon"></i>
                    ${info.name}
                </span>
            </td>
            <td>
                <div class="form-check">
                    <input class="form-check-input" 
                           type="checkbox" 
                           id="view-${profile}-${module}"
                           ${permission.can_view ? 'checked' : ''}
                           ${isAdmin ? 'disabled' : ''}
                           onchange="handlePermissionChange('${profile}', '${module}', this.checked)">
                    <label class="form-check-label" for="view-${profile}-${module}">
                        Permitir Acesso
                    </label>
                </div>
            </td>
        </tr>
    `;
}

// Alterna a exibição de uma seção de perfil
function toggleProfileSection(profile) {
    const content = document.getElementById(`content-${profile}`);
    const header = document.querySelector(`#section-${profile} .profile-header`);
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        header.classList.remove('collapsed');
    } else {
        content.style.display = 'none';
        header.classList.add('collapsed');
    }
}

// Manipula mudanças nas permissões
function handlePermissionChange(profile, module, value) {
    const permission = permissionsData[profile].find(p => p.module === module);
    
    if (permission) {
        permission.can_view = value;
    }
}

// Salva as permissões no servidor
async function savePermissions() {
    // Verificar se houve alterações
    if (JSON.stringify(permissionsData) === JSON.stringify(originalPermissions)) {
        alert('Nenhuma alteração foi feita.');
        return;
    }

    if (!confirm('Deseja salvar as alterações nas permissões? Isso afetará o acesso dos usuários ao sistema.')) {
        return;
    }

    showLoading(true);

    try {
        // Salvar permissões de cada perfil (exceto admin)
        const profilesToUpdate = ['supervisor', 'usuario'];
        
        for (const profile of profilesToUpdate) {
            if (permissionsData[profile]) {
                const response = await fetch(`/api/permissions/${profile}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        permissions: permissionsData[profile]
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || `Erro ao salvar permissões do perfil ${profile}`);
                }
            }
        }

        alert('Permissões salvas com sucesso!');
        
        // Atualizar o backup das permissões originais
        originalPermissions = JSON.parse(JSON.stringify(permissionsData));
        
    } catch (error) {
        console.error('Erro ao salvar permissões:', error);
        alert(`Erro ao salvar permissões: ${error.message}`);
    } finally {
        showLoading(false);
    }
}

// Mostra/oculta o overlay de carregamento
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

// Adiciona listener para confirmação antes de sair se houver alterações não salvas
window.addEventListener('beforeunload', (e) => {
    if (JSON.stringify(permissionsData) !== JSON.stringify(originalPermissions)) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
});
