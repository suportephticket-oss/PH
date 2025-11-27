// --- BUSCA DE PROTOCOLO ---
document.addEventListener('DOMContentLoaded', () => {
    const searchProtocolForm = document.getElementById('search-protocol-form');
    const searchProtocolInput = document.getElementById('search-protocol-input');
    const searchProtocolFilter = document.getElementById('search-protocol-filter');
    const searchProtocolResult = document.getElementById('search-protocol-result');

    if (searchProtocolForm) {
        searchProtocolForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentUserStr = localStorage.getItem('currentUser');
            const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
            if (!currentUser) return;
            
            const protocolNumber = searchProtocolInput.value.trim();
            const filterType = searchProtocolFilter.value;
            
            if (!protocolNumber) {
                searchProtocolResult.innerHTML = '<div class="alert alert-warning">Por favor, digite um número de protocolo.</div>';
                return;
            }
            
            searchProtocolResult.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Carregando...</span></div></div>';
            
            try {
                const response = await fetch(`/api/tickets/protocol/${encodeURIComponent(protocolNumber)}?userId=${currentUser.id}&filterType=${filterType}`);
                
                if (!response.ok) {
                    if (response.status === 404) {
                        searchProtocolResult.innerHTML = '<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>Protocolo não encontrado.</div>';
                    } else {
                        throw new Error('Erro ao buscar protocolo.');
                    }
                    return;
                }
                
                let ticket = await response.json();
                if (Array.isArray(ticket)) {
                    ticket = ticket[0] || null;
                }
                if (!ticket) {
                    searchProtocolResult.innerHTML = '<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>Protocolo não encontrado.</div>';
                    return;
                }
                
                // Renderiza o resultado
                let resultHtml = `
                    <div class="card">
                        <div class="card-header bg-primary text-white">
                            <h6 class="mb-0"><i class="bi bi-file-earmark-text me-2"></i>Protocolo: ${ticket.protocol_number || '-'}</h6>
                        </div>
                        <div class="card-body">
                            <p><strong>Contato:</strong> ${ticket.contact_name || 'Não informado'}</p>
                            <p><strong>Número:</strong> ${ticket.contact_number || '-'}</p>
                            <p><strong>Status:</strong> <span class="badge bg-${ticket.status === 'resolved' ? 'success' : ticket.status === 'attending' ? 'primary' : 'warning'}">${ticket.status === 'resolved' ? 'Concluído' : ticket.status === 'attending' ? 'Atendendo' : 'Pendente'}</span></p>
                            ${ticket.responsible_agent ? `<p><strong>Agente Responsável:</strong> ${ticket.responsible_agent}</p>` : ''}
                `;
                
                if (ticket.has_access) {
                    // Tem acesso ao chat completo
                    resultHtml += `
                            <hr>
                            <button class="btn btn-success w-100" onclick="window.loadChatFromSearch(${ticket.id})">
                                <i class="bi bi-chat-dots me-2"></i>Abrir Chat Completo
                            </button>
                    `;
                } else {
                    // Não tem acesso - mostra mensagem
                    resultHtml += `
                            <hr>
                            <div class="alert alert-info mb-0">
                                <i class="bi bi-info-circle me-2"></i>Este ticket está sendo atendido por outro agente. Você não tem acesso ao histórico completo.
                            </div>
                    `;
                }
                
                resultHtml += `
                        </div>
                    </div>
                `;
                
                searchProtocolResult.innerHTML = resultHtml;
                
            } catch (error) {
                console.error('Erro ao buscar protocolo:', error);
                searchProtocolResult.innerHTML = '<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>Erro ao buscar protocolo. Tente novamente.</div>';
            }
        });
    }

    // Função global para abrir chat a partir da busca
    window.loadChatFromSearch = async function(ticketId) {
        // Fecha o modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('searchProtocolModal'));
        if (modal) modal.hide();
        
        // Muda para a aba de atendimentos
        const menuIngressos = document.getElementById('menu-ingressos');
        if (menuIngressos) menuIngressos.click();
        
        // Aguarda um pouco para garantir que a interface carregou
        setTimeout(() => {
            const event = new CustomEvent('loadChatFromSearch', { detail: ticketId });
            document.dispatchEvent(event);
        }, 300);
    };
});
