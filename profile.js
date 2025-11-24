// profile.js - Lógica para a página de perfil

(function() {
    'use strict';

    // Carregar dados do perfil
    function loadProfile() {
        fetch('/api/auth/me', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + localStorage.getItem('token')
            }
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const user = data.user;
                document.getElementById('profile-name-display').textContent = user.name || 'N/A';
                document.getElementById('profile-email-display').textContent = user.email || 'N/A';

                // Carregar filas
                fetch('/api/users/' + user.id + '/queues', {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + localStorage.getItem('token')
                    }
                })
                .then(r => r.json())
                .then(queueData => {
                    const queuesDisplay = document.getElementById('profile-queues-display');
                    if (queueData.success && queueData.queues.length > 0) {
                        queuesDisplay.textContent = queueData.queues.map(q => q.name).join(', ');
                    } else {
                        queuesDisplay.textContent = 'Nenhuma fila atribuída';
                    }
                })
                .catch(err => {
                    console.error('Erro ao carregar filas:', err);
                    document.getElementById('profile-queues-display').textContent = 'Erro ao carregar';
                });
            } else {
                alert('Erro ao carregar perfil.');
                window.location.href = 'index.html';
            }
        })
        .catch(err => {
            console.error('Erro ao carregar perfil:', err);
            alert('Erro ao carregar perfil.');
            window.location.href = 'index.html';
        });
    }

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
                alert('Por favor, preencha todos os campos.');
                return;
            }

            if (newPassword.length < 6) {
                alert('A nova senha deve ter pelo menos 6 caracteres.');
                return;
            }

            if (newPassword !== confirmPassword) {
                alert('A nova senha e a confirmação não coincidem.');
                return;
            }

            // Obter ID do usuário
            fetch('/api/auth/me', {
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + localStorage.getItem('token')
                }
            })
            .then(r => r.json())
            .then(userData => {
                if (userData.success) {
                    const userId = userData.user.id;

                    // Enviar para o backend
                    fetch('/api/users/' + userId + '/password', {
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
                            alert('Senha alterada com sucesso!');
                            const changePasswordModal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
                            changePasswordModal.hide();
                            // Limpar campos
                            document.getElementById('current-password').value = '';
                            document.getElementById('new-password').value = '';
                            document.getElementById('confirm-new-password').value = '';
                        } else {
                            alert(data.message || 'Erro ao alterar senha.');
                        }
                    })
                    .catch(err => {
                        console.error('Erro ao alterar senha:', err);
                        alert('Erro ao alterar senha. Tente novamente.');
                    });
                } else {
                    alert('Erro ao obter dados do usuário.');
                }
            })
            .catch(err => {
                console.error('Erro ao obter dados do usuário:', err);
                alert('Erro ao obter dados do usuário.');
            });
        });
    }

    // Carregar perfil ao carregar a página
    loadProfile();
})();