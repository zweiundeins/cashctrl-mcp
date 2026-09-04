import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const user = (text: string) => ({
  messages: [{
    role: "user" as const,
    content: { type: "text" as const, text },
  }],
});

/**
 * `registerPrompt` types its callback through a conditional type, which
 * TypeScript cannot use to contextually type a lambda, so the arguments come
 * back as `any`. Pinning the shape here keeps the cast in one place.
 */
function definePrompt<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; argsSchema: S },
  handler: (args: z.output<z.ZodObject<S>>) => ReturnType<typeof user>,
): void {
  // deno-lint-ignore no-explicit-any
  server.registerPrompt(name, config as any, handler as any);
}

/** Recurring accounting questions, phrased so the period trap is handled. */
export function registerPrompts(server: McpServer): void {
  definePrompt(server, "offene-posten", {
    title: "Offene Posten",
    description: "Open and overdue invoices, grouped by customer.",
    argsSchema: {
      type: z.string().optional().describe("SALES or PURCHASE, default SALES"),
    },
  }, ({ type }) =>
    user(
      `Zeig mir die offenen Posten (${type || "SALES"}).\n\n` +
        "Nutze list_open_invoices. Gruppiere nach Kunde, sortiere nach " +
        "Fälligkeit, und weise überfällige Rechnungen mit der Anzahl Tage " +
        "Verzug aus. Nenne die Summe der offenen Beträge pro Währung.",
    ));

  definePrompt(server, "monatsabschluss-check", {
    title: "Monatsabschluss-Check",
    description: "Sanity checks over one month's bookings.",
    argsSchema: {
      month: z.string().describe("Month as YYYY-MM, e.g. 2026-01"),
    },
  }, ({ month }) =>
    user(
      `Prüfe den Monat ${month}.\n\n` +
        "Lies zuerst cashctrl://org/summary, um die richtige Fiskalperiode zu " +
        "bestimmen — die aktuelle Periode der Organisation ist nicht " +
        "zwingend das laufende Jahr.\n\n" +
        "Dann mit get_journal die Buchungen des Monats holen und prüfen:\n" +
        "- Buchungen ohne Steuercode auf Aufwands- oder Ertragskonten\n" +
        "- auffällig runde oder doppelte Beträge am selben Tag\n" +
        "- Buchungen auf Durchlauf- oder Verrechnungskonten, die offen bleiben\n" +
        "- offene Posten mit Fälligkeit in diesem Monat\n\n" +
        "Fasse zusammen, was geprüft wurde, und liste nur die Auffälligkeiten " +
        "mit Buchungs-ID.",
    ));

  definePrompt(server, "bank-abgleich", {
    title: "Bankabgleich",
    description: "Reviews how imported bank statements were booked.",
    argsSchema: {
      from: z.string().describe("Start date, YYYY-MM-DD"),
      to: z.string().describe("End date, YYYY-MM-DD"),
    },
  }, ({ from, to }) =>
    user(
      `Prüfe, wie die importierten Bankbuchungen von ${from} bis ${to} ` +
        "verbucht wurden.\n\n" +
        "Nutze review_bank_import. Geh dabei so vor:\n" +
        "- Schau zuerst die Verteilung nach Gegenkonto an: Konten mit vielen " +
        "kleinen Buchungen oder ungewöhnlich hohen Summen sind verdächtig.\n" +
        "- Nimm die markierten Buchungen einzeln durch und sag zu jeder, ob " +
        "sie plausibel ist oder korrigiert gehört.\n" +
        "- Weise ausdrücklich auf Importe hin, deren Einträge nie verbucht " +
        "wurden — die sind sonst unsichtbar.\n\n" +
        "Behaupte nichts über Buchungen, die du nicht gesehen hast, und " +
        "korrigiere nichts selbst: dieser Server liest nur.",
    ));

  definePrompt(server, "jahresabschluss", {
    title: "Jahresabschluss",
    description: "Walks the year-end checklist for a fiscal period.",
    argsSchema: {
      fiscalPeriodId: z.string().optional().describe(
        "Fiscal period id; defaults to the current one",
      ),
    },
  }, ({ fiscalPeriodId }) =>
    user(
      `Führe mich durch den Jahresabschluss${
        fiscalPeriodId ? ` für Fiskalperiode ${fiscalPeriodId}` : ""
      }.\n\n` +
        "Beginne mit get_fiscal_period_status: Ergebnis, abgeschlossene " +
        "Monate, offene Abschreibungen und Währungsdifferenzen.\n\n" +
        "Lass dann validate_year_end laufen und geh die Checks durch: FAIL " +
        "zuerst, dann WARN, dann die INFO-Abstimmungen.\n\n" +
        "Schau dann mit get_history nach, was beim letzten Jahresabschluss " +
        "tatsächlich gemacht wurde — Korrekturen, gelöschte Buchungen, " +
        "Statuswechsel. Das ist die beste Vorlage für die diesjährige " +
        "Liste.\n\n" +
        "Dann prüfe der Reihe nach:\n" +
        "- Offene Posten: Debitoren und Kreditoren, die am Jahresende noch " +
        "offen sind (list_open_invoices, beide Typen).\n" +
        "- Durchlauf- und Verrechnungskonten, die nicht auf null stehen " +
        "(get_account_balance auf das Periodenende).\n" +
        "- Bilanz und Erfolgsrechnung über get_report gegenlesen; stimmt das " +
        "Ergebnis mit fiscalperiod/result überein?\n" +
        "- Bankbuchungen des Jahres mit review_bank_import durchsehen.\n\n" +
        "Gib am Ende eine Liste der offenen Punkte aus, nach Dringlichkeit " +
        "sortiert. Das Buchen von Abschreibungen, Währungsdifferenzen und das " +
        "Abschliessen der Periode sind Schreibvorgänge und hier nicht " +
        "möglich — nenne sie als Aufgaben, führe sie nicht aus.",
    ));

  definePrompt(server, "mwst-abstimmung", {
    title: "MWST-Abstimmung",
    description: "Reconciles the VAT report against the VAT accounts.",
    argsSchema: {
      from: z.string().describe("Start date, YYYY-MM-DD"),
      to: z.string().describe("End date, YYYY-MM-DD"),
    },
  }, ({ from, to }) =>
    user(
      `Stimme die MWST für ${from} bis ${to} ab.\n\n` +
        "Suche mit get_report (ohne elementId) den MWST-Bericht, rendere ihn " +
        "für den Zeitraum, und vergleiche ihn mit den Salden der " +
        "MWST-Konten via get_account_balance. Nenne Differenzen mit Betrag " +
        "und wahrscheinlicher Ursache; behaupte keine Übereinstimmung, die du " +
        "nicht gerechnet hast.\n\n" +
        "Prüfe zusätzlich mit review_bank_import, ob importierte " +
        "Bankbuchungen ohne Steuercode verbucht wurden — das ist die " +
        "häufigste Ursache für eine zu tiefe Vorsteuer.",
    ));
}
