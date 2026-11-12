export function AppIcon() {
  return (
    <img
      src={new URL('../../assets/images/logo.png', import.meta.url).href}
      alt="gxShell"
      style={{ width: 28, height: 28, objectFit: 'contain' }}
    />
  );
}
