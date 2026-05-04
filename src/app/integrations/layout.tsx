export default function IntegrationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`body { overflow: auto !important; }`}</style>
      {children}
    </>
  );
}
