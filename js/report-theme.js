/**
 * Shared FleetMagnify PDF report theme.
 * All customer-facing PDF exports should use these helpers so chrome,
 * typography, and account naming stay consistent across report types.
 */
window.FleetMagnifyReportTheme = (function () {
  'use strict';

  var COLORS = {
    navy: [27, 46, 74],         // #1B2E4A
    navyLight: [46, 74, 110],   // #2E4A6E
    slate: [92, 107, 122],      // #5C6B7A
    paleBlue: [238, 242, 247],  // #EEF2F7
    groupTint: [220, 230, 240], // #DCE6F0
    amber: [196, 121, 26],      // #C4791A
    amberTint: [251, 240, 223], // #FBF0DF
    line: [213, 220, 227],      // #D5DCE3
    white: [255, 255, 255],
    charcoal: [30, 40, 55]
  };

  var LAYOUT = {
    margin: 14,
    font: 'helvetica',
    amberRuleMm: 0.8,
    footerReserve: 14
  };

  var FALLBACK_ACCOUNT_NAME = 'Fleet Account';

  function pageWidth(doc) {
    return doc.internal.pageSize.getWidth();
  }

  function pageHeight(doc) {
    return doc.internal.pageSize.getHeight();
  }

  /**
   * Read-only lookup of profiles.company_name for the account owner.
   * Never derives a name from email. Falls back to a generic label.
   */
  async function resolveAccountDisplayName(supabase, accountId) {
    if (!accountId) return FALLBACK_ACCOUNT_NAME;
    try {
      var result = await supabase
        .from('profiles')
        .select('company_name')
        .eq('id', accountId)
        .maybeSingle();
      var name = result.data && result.data.company_name
        ? String(result.data.company_name).trim()
        : '';
      return name || FALLBACK_ACCOUNT_NAME;
    } catch (e) {
      return FALLBACK_ACCOUNT_NAME;
    }
  }

  function formatGeneratedDate(date) {
    var d = date || new Date();
    return d.toLocaleDateString('en-NZ', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function drawAmberTopRule(doc) {
    doc.setFillColor.apply(doc, COLORS.amber);
    doc.rect(0, 0, pageWidth(doc), LAYOUT.amberRuleMm, 'F');
  }

  /**
   * Header: FleetMagnify wordmark + tagline left; report title + subtitle right.
   * Returns the Y position beneath the header rule.
   */
  function drawHeader(doc, opts) {
    opts = opts || {};
    var margin = LAYOUT.margin;
    var pageW = pageWidth(doc);

    drawAmberTopRule(doc);

    doc.setTextColor.apply(doc, COLORS.navy);
    doc.setFont(LAYOUT.font, 'bold');
    doc.setFontSize(15);
    doc.text('FleetMagnify', margin, 11);

    doc.setFont(LAYOUT.font, 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, COLORS.slate);
    doc.text('Fleet Cost Analytics · fleetmagnify.com', margin, 16);

    doc.setFont(LAYOUT.font, 'bold');
    doc.setFontSize(11);
    doc.setTextColor.apply(doc, COLORS.navy);
    doc.text(opts.title || '', pageW - margin, 11, { align: 'right' });

    if (opts.subtitle) {
      doc.setFont(LAYOUT.font, 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor.apply(doc, COLORS.slate);
      doc.text(opts.subtitle, pageW - margin, 16, { align: 'right' });
    }

    doc.setDrawColor.apply(doc, COLORS.line);
    doc.setLineWidth(0.3);
    doc.line(margin, 20, pageW - margin, 20);

    return 24;
  }

  /**
   * Meta line beneath the header.
   * Format: Prepared for X · Submitted to Y · Generated Z
   * Report-ref intentionally omitted for now.
   * Returns the next Y.
   */
  function drawMetaLine(doc, y, opts) {
    opts = opts || {};
    var parts = [];
    if (opts.accountName) parts.push('Prepared for ' + opts.accountName);
    if (opts.submittedTo) parts.push('Submitted to ' + opts.submittedTo);
    parts.push('Generated ' + (opts.generated || formatGeneratedDate()));

    doc.setFont(LAYOUT.font, 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, COLORS.slate);
    var text = parts.join(' · ');
    var maxW = pageWidth(doc) - LAYOUT.margin * 2;
    var lines = doc.splitTextToSize(text, maxW);
    doc.text(lines, LAYOUT.margin, y);
    return y + lines.length * 3.6 + 4;
  }

  /**
   * Pale-blue panel with 3–4 summary stat cards.
   * stats: [{ label, value, accent? }]
   * Returns the next Y.
   */
  function drawStatCards(doc, y, stats) {
    stats = (stats || []).slice(0, 4);
    if (!stats.length) return y;

    var margin = LAYOUT.margin;
    var pageW = pageWidth(doc);
    var contentW = pageW - margin * 2;
    var panelH = 20;
    var n = stats.length;
    var colW = contentW / n;

    doc.setFillColor.apply(doc, COLORS.paleBlue);
    doc.roundedRect(margin, y, contentW, panelH, 1.5, 1.5, 'F');

    for (var i = 0; i < n; i++) {
      var s = stats[i];
      var cx = margin + colW * i + colW / 2;
      doc.setFont(LAYOUT.font, 'bold');
      doc.setFontSize(13);
      doc.setTextColor.apply(doc, s.accent ? COLORS.amber : COLORS.navy);
      doc.text(String(s.value == null ? '—' : s.value), cx, y + 9, { align: 'center' });

      doc.setFont(LAYOUT.font, 'normal');
      doc.setFontSize(6);
      doc.setTextColor.apply(doc, COLORS.slate);
      doc.text(String(s.label || '').toUpperCase(), cx, y + 15.5, { align: 'center' });
    }

    return y + panelH + 6;
  }

  function drawGrandTotalBand(doc, y, label, value) {
    var margin = LAYOUT.margin;
    var pageW = pageWidth(doc);
    var contentW = pageW - margin * 2;
    var h = 9;

    // Ensure room before footer
    if (y + h > pageHeight(doc) - LAYOUT.footerReserve) {
      doc.addPage();
      y = LAYOUT.margin;
    }

    doc.setFillColor.apply(doc, COLORS.navy);
    doc.rect(margin, y, contentW, h, 'F');
    doc.setFont(LAYOUT.font, 'bold');
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, COLORS.white);
    doc.text(String(label || ''), margin + 3, y + 6);
    doc.text(String(value || ''), pageW - margin - 3, y + 6, { align: 'right' });
    return y + h + 3;
  }

  function drawFooter(doc, pageNumber) {
    var pageW = pageWidth(doc);
    var pageH = pageHeight(doc);
    var margin = LAYOUT.margin;
    var pageNum = pageNumber != null
      ? pageNumber
      : (doc.internal.getCurrentPageInfo
        ? doc.internal.getCurrentPageInfo().pageNumber
        : doc.internal.getNumberOfPages());

    doc.setDrawColor.apply(doc, COLORS.line);
    doc.setLineWidth(0.25);
    doc.line(margin, pageH - 11, pageW - margin, pageH - 11);

    doc.setFont(LAYOUT.font, 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor.apply(doc, COLORS.slate);
    doc.text(
      'FleetMagnify · Fleet cost analytics for NZ trucking & machinery fleets · fleetmagnify.com',
      margin,
      pageH - 6.5
    );
    doc.text('Page ' + pageNum, pageW - margin, pageH - 6.5, { align: 'right' });
  }

  /** Stamp the shared footer on every page. Call after all content is drawn. */
  function applyFooters(doc) {
    var pageCount = doc.internal.getNumberOfPages();
    for (var i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      drawFooter(doc, i);
    }
  }

  function tableHeadStyles() {
    return {
      fillColor: COLORS.navy,
      textColor: COLORS.white,
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: 2.4,
      halign: 'left'
    };
  }

  function tableBodyStyles() {
    return {
      font: LAYOUT.font,
      fontSize: 8,
      cellPadding: 2.2,
      textColor: COLORS.charcoal,
      lineColor: COLORS.line,
      lineWidth: 0.1,
      overflow: 'linebreak'
    };
  }

  /**
   * Baseline autoTable options. Merge with report-specific overrides.
   * Expects body rows that may include __rowType: 'group' | 'subtotal' | 'data'
   * when using object-style cells, or sentinel strings in column 0.
   */
  function tableOptions(overrides) {
    overrides = overrides || {};
    var margin = LAYOUT.margin;
    var base = {
      margin: { left: margin, right: margin, bottom: LAYOUT.footerReserve },
      styles: tableBodyStyles(),
      headStyles: tableHeadStyles(),
      showHead: 'everyPage',
      theme: 'plain',
      didParseCell: function (data) {
        var rowType = detectRowType(data.row.raw);

        if (rowType === 'group') {
          data.cell.styles.fillColor = COLORS.groupTint;
          data.cell.styles.textColor = COLORS.navy;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fontSize = 8;
        } else if (rowType === 'subtotal') {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = COLORS.navy;
          if (data.column.index === data.table.columns.length - 1) {
            data.cell.styles.textColor = COLORS.amber;
          }
        } else if (data.section === 'body' && data.cell.text && data.cell.text.length === 1 && data.cell.text[0] === '—') {
          data.cell.styles.textColor = COLORS.slate;
          data.cell.styles.fontStyle = 'italic';
        }

        if (typeof overrides.didParseCell === 'function') {
          overrides.didParseCell(data);
        }
      },
      didDrawCell: function (data) {
        var rowType = detectRowType(data.row.raw);

        if (rowType === 'group' && data.column.index === 0 && data.section === 'body') {
          data.doc.setFillColor.apply(data.doc, COLORS.amber);
          data.doc.rect(data.cell.x, data.cell.y, 1.2, data.cell.height, 'F');
        }

        if (rowType === 'subtotal' && data.column.index === 0 && data.section === 'body') {
          data.doc.setDrawColor.apply(data.doc, COLORS.line);
          data.doc.setLineWidth(0.3);
          var ruleW = data.table.width || (pageWidth(data.doc) - LAYOUT.margin * 2);
          data.doc.line(data.cell.x, data.cell.y, data.cell.x + ruleW, data.cell.y);
        }

        if (typeof overrides.didDrawCell === 'function') {
          overrides.didDrawCell(data);
        }
      }
    };

    Object.keys(overrides).forEach(function (key) {
      if (key === 'didParseCell' || key === 'didDrawCell') return;
      base[key] = overrides[key];
    });

    return base;
  }

  /** Build a group-header autoTable row spanning all columns. */
  function groupRow(label, colCount) {
    return [{
      content: label,
      colSpan: colCount,
      __rowType: 'group',
      styles: {
        fillColor: COLORS.groupTint,
        textColor: COLORS.navy,
        fontStyle: 'bold',
        fontSize: 8
      }
    }];
  }

  /** Build a subtotal autoTable row. */
  function subtotalRow(label, value, colCount) {
    var span = Math.max(1, colCount - 1);
    return [
      {
        content: label,
        colSpan: span,
        __rowType: 'subtotal',
        styles: { fontStyle: 'bold', textColor: COLORS.navy }
      },
      {
        content: value,
        __rowType: 'subtotal',
        styles: { fontStyle: 'bold', textColor: COLORS.amber, halign: 'right' }
      }
    ];
  }

  function detectRowType(raw) {
    if (!raw) return null;
    if (raw.__rowType) return raw.__rowType;
    if (raw[0] && typeof raw[0] === 'object' && raw[0].__rowType) return raw[0].__rowType;
    if (typeof raw[0] === 'string') {
      if (String(raw[0]).indexOf('__GROUP__') === 0) return 'group';
      if (String(raw[0]).indexOf('__SUBTOTAL__') === 0) return 'subtotal';
    }
    return null;
  }

  return {
    COLORS: COLORS,
    LAYOUT: LAYOUT,
    FALLBACK_ACCOUNT_NAME: FALLBACK_ACCOUNT_NAME,
    resolveAccountDisplayName: resolveAccountDisplayName,
    formatGeneratedDate: formatGeneratedDate,
    drawHeader: drawHeader,
    drawMetaLine: drawMetaLine,
    drawStatCards: drawStatCards,
    drawGrandTotalBand: drawGrandTotalBand,
    drawFooter: drawFooter,
    applyFooters: applyFooters,
    tableHeadStyles: tableHeadStyles,
    tableBodyStyles: tableBodyStyles,
    tableOptions: tableOptions,
    groupRow: groupRow,
    subtotalRow: subtotalRow
  };
})();
