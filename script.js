document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const toggleLink = document.getElementById('toggle-link');
    const formTitle = document.getElementById('form-title');
    const formTitleText = document.getElementById('form-title-text');
    const alertMessage = document.getElementById('alert-message');

    // Alternar entre formulário de login e registro
    toggleLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (loginForm.classList.contains('d-none')) {
            // Mudar para Login
            loginForm.classList.remove('d-none');
            registerForm.classList.add('d-none');
            if (formTitleText) formTitleText.textContent = 'Login';
            toggleLink.textContent = 'Não tem uma conta? Crie sua conta';
        } else {
            // Mudar para Registro
            loginForm.classList.add('d-none');
            registerForm.classList.remove('d-none');
            if (formTitleText) formTitleText.textContent = 'Criar Conta';
            toggleLink.textContent = 'Já tem uma conta? Faça login';
        }
        hideAlert();
    });

    // Função para exibir alertas
    function showAlert(message, type = 'danger') {
        alertMessage.textContent = message;
        alertMessage.className = `alert alert-${type}`;
        alertMessage.classList.remove('d-none');
    }

    // Função para esconder alertas
    function hideAlert() {
        alertMessage.classList.add('d-none');
    }

    // Lidar com o envio do formulário de registro
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlert();

        const name = document.getElementById('register-name').value.trim();
        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const passwordConfirm = document.getElementById('register-password-confirm').value;

        // Validações no frontend
        if (!name || name.length < 3) {
            showAlert('O nome deve ter pelo menos 3 caracteres.');
            return;
        }

        if (!email || !email.includes('@')) {
            showAlert('Por favor, insira um email válido.');
            return;
        }

        if (password.length < 6) {
            showAlert('A senha deve ter pelo menos 6 caracteres.');
            return;
        }

        if (password !== passwordConfirm) {
            showAlert('As senhas não coincidem. Por favor, verifique.');
            return;
        }

        try {
            const response = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password })
            });

            const data = await response.json();

            if (response.ok) {
                // Verificar se o email foi enviado
                if (data.emailSent) {
                    showAlert(
                        `✅ Conta criada com sucesso!\n\n📧 Um email de verificação foi enviado para ${email}.\n\nPor favor, verifique sua caixa de entrada (e spam) e clique no link para ativar sua conta.`,
                        'success'
                    );
                } else if (data.emailSent === false) {
                    showAlert(
                        `⚠️ Conta criada, mas houve erro ao enviar o email de verificação.\n\nPor favor, contate o administrador.`,
                        'warning'
                    );
                } else {
                    showAlert('✅ Conta criada com sucesso! Você já pode fazer login.', 'success');
                }
                
                // Limpa o formulário
                registerForm.reset();
                
                // Volta para o login após 5 segundos
                setTimeout(() => {
                    toggleLink.click(); 
                }, 5000);
            } else {
                showAlert(data.error || data.message || 'Erro ao criar conta.');
            }
        } catch (error) {
            showAlert('Não foi possível conectar ao servidor. Verifique sua conexão.');
        }
    });

    // Lidar com o envio do formulário de login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlert();

        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok) {
                // Salva os dados do usuário no localStorage
                if (data.user) {
                    localStorage.setItem('currentUser', JSON.stringify(data.user));
                }
                // Salva o token de sessão
                if (data.sessionToken) {
                    localStorage.setItem('sessionToken', data.sessionToken);
                }
                // Login bem-sucedido, redireciona para o painel
                window.location.href = '/dashboard';
            } else {
                // Verificar se o erro é por email não verificado
                if (data.emailNotVerified) {
                    showAlert('📧 ' + data.message + '\n\nVerifique sua caixa de entrada e spam.');
                } else {
                    showAlert(data.message || 'Erro ao fazer login.');
                }
            }
        } catch (error) {
            showAlert('Não foi possível conectar ao servidor.');
        }
    });

    // Lidar com o envio do formulário de reenvio de confirmação
    const resendForm = document.getElementById('resend-verification-form');
    if (resendForm) {
        resendForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();
            const email = document.getElementById('resend-email').value.trim();
            if (!email || !email.includes('@')) {
                showAlert('Por favor, insira um email válido.');
                return;
            }
            try {
                const response = await fetch('/api/resend-verification', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await response.json();
                if (response.ok) {
                    showAlert('📧 Um novo email de confirmação foi enviado para ' + email + '. Verifique sua caixa de entrada e spam.', 'success');
                    resendForm.reset();
                } else {
                    showAlert(data.error || 'Erro ao reenviar confirmação.');
                }
            } catch (error) {
                showAlert('Não foi possível conectar ao servidor.');
            }
        });
    }
});
