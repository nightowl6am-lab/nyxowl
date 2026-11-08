interface InvoiceListProps {
  loading: boolean;
  invoices: Array<{ id: string; totalCents: number }>;
}

export function InvoiceList({ loading, invoices }: InvoiceListProps) {
  return (
    <section aria-live="polite">
      {loading ? (
        <p>Loading invoices</p>
      ) : invoices.length === 0 ? (
        <p>No results yet</p>
      ) : (
        <ul>
          {invoices.map((invoice) => (
            <li key={invoice.id}>{invoice.totalCents}</li>
          ))}
        </ul>
      )}
      <button className="focus-visible:ring">Retry</button>
    </section>
  );
}
