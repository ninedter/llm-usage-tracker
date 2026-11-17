"use client";

interface CreditSectionProps {
  title?: string;
  /** Red pill beside the heading, e.g. "Out of credits" / "Depleted". */
  alert?: string;
  children: React.ReactNode;
}

/** "Add-on credits" block shared by the provider cards. */
export function CreditSection({ title = "Add-on credits", alert, children }: CreditSectionProps) {
  return (
    <div className="space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {title}
        </h4>
        {alert && (
          <span className="inline-flex flex-shrink-0 items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
            {alert}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
