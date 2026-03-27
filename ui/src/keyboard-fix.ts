// Android Chrome keyboard fix - comprehensive version
(function() {
  const DEBUG = false;
  function log(...args: any[]) { if (DEBUG) console.log('[KB-FIX]', ...args); }
  
  function init() {
    log('Keyboard fix initializing');
    let lastInnerHeight = window.innerHeight;
    let isKeyboardOpen = false;
    
    function detectAndFix() {
      const currentHeight = window.innerHeight;
      const heightDiff = lastInnerHeight - currentHeight;
      
      // Keyboard is typically > 150px
      const keyboardOpen = heightDiff > 150 && currentHeight < lastInnerHeight;
      
      log('Height:', currentHeight, 'last:', lastInnerHeight, 'diff:', heightDiff, 'KB:', keyboardOpen);
      
      const app = document.querySelector('.app') || document.querySelector('#app');
      const compose = document.querySelector('.view-compose');
      
      if (!compose) return;
      
      if (keyboardOpen && !isKeyboardOpen) {
        // Keyboard just opened
        isKeyboardOpen = true;
        log('Keyboard opened, adjusting...');
        
        // Aggressive: move compose above keyboard
        const keyboardHeight = heightDiff;
        
        // Method 1: Fixed position with keyboard height
        compose.style.position = 'fixed';
        compose.style.bottom = keyboardHeight + 'px';
        compose.style.left = '0';
        compose.style.right = '0';
        compose.style.width = '100%';
        compose.style.zIndex = '99999';
        
        // Also adjust app to not overflow
        if (app) {
          app.style.height = currentHeight + 'px';
          app.style.overflow = 'hidden';
        }
        
        // Final resort: scroll window
        setTimeout(() => {
          const input = compose.querySelector('textarea');
          if (input) {
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          window.scrollTo(0, document.body.scrollHeight);
        }, 300);
        
      } else if (!keyboardOpen && isKeyboardOpen) {
        // Keyboard just closed
        isKeyboardOpen = false;
        log('Keyboard closed, restoring...');
        
        compose.style.position = '';
        compose.style.bottom = '';
        compose.style.left = '';
        compose.style.right = '';
        compose.style.width = '';
        compose.style.zIndex = '';
        
        if (app) {
          app.style.height = '';
          app.style.overflow = '';
        }
      }
      
      lastInnerHeight = currentHeight;
    }
    
    // Check frequently
    window.addEventListener('resize', detectAndFix);
    setInterval(detectAndCheck, 200);
    
    // Initial
    setTimeout(detectAndFix, 1000);
  }
  
  function detectAndCheck() {
    const compose = document.querySelector('.view-compose') as HTMLElement;
    const textarea = compose?.querySelector('textarea') as HTMLTextAreaElement;
    
    if (textarea && document.hasFocus()) {
      // Check if textarea is partially hidden
      const rect = textarea.getBoundingClientRect();
      const visibleBottom = window.innerHeight;
      
      if (rect.bottom > visibleBottom - 50) {
        // Hidden by keyboard - force scroll
        textarea.scrollIntoView({ block: 'end', behavior: 'smooth' });
        window.scrollBy({ top: 50, behavior: 'smooth' });
      }
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();