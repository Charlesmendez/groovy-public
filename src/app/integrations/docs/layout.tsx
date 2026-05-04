export default function DocsLayout({
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
