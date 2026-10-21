import('./app.js').catch(error => {
  console.error('Game resources failed to load:', error);
  const loading = document.getElementById('loading');
  loading.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = '营地物资还在路上';
  const message = document.createElement('span');
  message.textContent = '部分游戏资源未能加载，请检查网络后重试。';
  const button = document.createElement('button');
  button.className = 'gold-button';
  button.textContent = '重新靠岸';
  button.addEventListener('click', () => location.reload());
  loading.append(title, message, button);
});
