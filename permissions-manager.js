/**
 * Sistema de Gerenciamento de Permissões - Frontend
 * 
 * Este módulo fornece funções para verificar permissões do usuário logado
 * e controlar a visibilidade de elementos da interface baseado nessas permissões.
 */

class PermissionsManager {
    constructor() {
        this.userPermissions = null;
        this.userProfile = null;
        this.isLoaded = false;
    }

    /**
     * Carrega as permissões do usuário logado
     * @returns {Promise<Object>} Permissões do usuário
     */
    async loadUserPermissions() {
        const sessionToken = localStorage.getItem('sessionToken');
        
        if (!sessionToken) {
            console.warn('PermissionsManager: Token de sessão não encontrado');
            return null;
        }

        try {
            const response = await fetch(`/api/user-permissions?sessionToken=${sessionToken}`);
            
            if (!response.ok) {
                console.error('PermissionsManager: Erro ao carregar permissões');
                return null;
            }

            const data = await response.json();
            this.userProfile = data.profile;
            this.userPermissions = data.permissions;
            this.isLoaded = true;

            return data;
        } catch (error) {
            console.error('PermissionsManager: Erro na requisição de permissões:', error);
            return null;
        }
    }

    /**
     * Verifica se o usuário tem permissão para visualizar um módulo
     * @param {string} module - Nome do módulo
     * @returns {boolean} True se pode visualizar
     */
    canView(module) {
        if (!this.isLoaded || !this.userPermissions) {
            console.warn(`PermissionsManager: Permissões não carregadas para verificar módulo ${module}`);
            return false;
        }

        // Admin sempre pode ver tudo
        if (this.userProfile === 'admin') {
            return true;
        }

        const permission = this.userPermissions[module];
        return permission ? permission.can_view : false;
    }

    /**
     * Verifica se o usuário tem permissão para excluir tickets
     * @returns {boolean} True se pode excluir tickets
     */
    canDeleteTickets() {
        return this.canView('delete_tickets');
    }

    /**
     * Verifica se o usuário é administrador
     * @returns {boolean} True se é admin
     */
    isAdmin() {
        return this.userProfile === 'admin';
    }

    /**
     * Verifica se o usuário é supervisor
     * @returns {boolean} True se é supervisor
     */
    isSupervisor() {
        return this.userProfile === 'supervisor';
    }

    /**
     * Obtém o perfil do usuário
     * @returns {string} Perfil do usuário
     */
    getUserProfile() {
        return this.userProfile;
    }

    /**
     * Aplica permissões na interface - oculta elementos baseado nas permissões
     * 
     * Formato esperado dos atributos data:
     * - data-permission-module="nome_do_modulo"
     * 
     * Exemplo:
     * <li data-permission-module="users">Menu Usuários</li>
     */
    applyUIPermissions() {
        if (!this.isLoaded) {
            console.warn('PermissionsManager: Tentativa de aplicar permissões antes de carregar');
            return;
        }

        // Encontra todos os elementos com permissões
        const elements = document.querySelectorAll('[data-permission-module]');
        
        elements.forEach(element => {
            const module = element.getAttribute('data-permission-module');
            const hasPermission = this.canView(module);

            if (!hasPermission) {
                // Oculta o elemento
                element.style.display = 'none';
                
                // Adiciona atributo para facilitar debug
                element.setAttribute('data-permission-hidden', 'true');
            } else {
                // Garante que elemento permitido está visível
                if (element.style.display === 'none' && !element.hasAttribute('data-original-hidden')) {
                    element.style.display = '';
                }
                
                element.removeAttribute('data-permission-hidden');
            }
        });
    }

    /**
     * Wrapper para verificação de permissão antes de executar uma ação
     * @param {string} module - Módulo a verificar
     * @param {Function} callback - Função a executar se tiver permissão
     * @param {Function} deniedCallback - Função a executar se não tiver permissão
     */
    ifHasPermission(module, callback, deniedCallback = null) {
        const hasPermission = this.canView(module);

        if (hasPermission && typeof callback === 'function') {
            callback();
        } else if (!hasPermission && typeof deniedCallback === 'function') {
            deniedCallback();
        } else if (!hasPermission) {
            console.warn(`PermissionsManager: Acesso negado ao módulo ${module}`);
        }
    }
}

// Instância global do gerenciador de permissões
const permissionsManager = new PermissionsManager();

// Auto-inicialização quando o DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
        await permissionsManager.loadUserPermissions();
        permissionsManager.applyUIPermissions();
    });
} else {
    // DOM já carregado
    permissionsManager.loadUserPermissions().then(() => {
        permissionsManager.applyUIPermissions();
    });
}

// Exporta para uso global
window.PermissionsManager = PermissionsManager;
window.permissionsManager = permissionsManager;
