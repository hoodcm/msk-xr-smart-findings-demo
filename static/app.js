// Session Management
function getOrCreateSessionId() {
    let sessionId = sessionStorage.getItem('sessionId');
    if (!sessionId) {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        sessionStorage.setItem('sessionId', sessionId);
    }
    return sessionId;
}

// Initialize session ID on page load
const sessionId = getOrCreateSessionId();
document.body.setAttribute('data-session', sessionId);
console.log('Session:', sessionId);

// DOM Element References
const modelSelect = document.getElementById('modelSelect');
const inputText = document.getElementById('inputText');
const processBtn = document.getElementById('processBtn');
const reportView = document.getElementById('reportView');
const structuredView = document.getElementById('structuredView');
const jsonView = document.getElementById('jsonView');
const reportViewBtn = document.getElementById('reportViewBtn');
const structuredViewBtn = document.getElementById('structuredViewBtn');
const jsonViewBtn = document.getElementById('jsonViewBtn');
const copyBtn = document.getElementById('copyBtn');
const processLoader = document.getElementById('processLoader');
const latency = document.getElementById('latency');

// State for current findings
let currentFindings = [];
let reportIsStreamed = false;

// Category colors are now CSS-driven via [data-category] selectors in style.css

// Map raw taxonomy categories to display categories (for draft tagged view)
function mapTagCategory(taxonomyId, rawCategory) {
    const id = parseInt(taxonomyId.replace('MID', ''), 10);
    if ((id >= 1000 && id <= 1295) || (id >= 2900 && id <= 2940)) return 'hardware';
    if (id >= 1300 && id <= 1395) return 'fracture';
    if (id >= 1500 && id <= 1640) return 'degenerative';
    if ((id >= 1400 && id <= 1410) || (id >= 1810 && id <= 1995)) return 'alignment';
    if (id >= 2000 && id <= 2145) return 'soft_tissue';
    if (id >= 2200 && id <= 2265) return 'metabolic';
    if (id >= 2300 && id <= 2405) return 'osseous_lesion';
    if (id >= 1700 && id <= 1800) return 'osseous';
    if (id >= 2800 && id <= 2870) return 'inflammatory';
    if (id >= 2600 && id <= 2715) return 'postsurgical';
    if (id >= 2500 && id <= 2550) return 'variant';
    return rawCategory;
}

// Format negative findings into combined narrative sentence
function formatNegatives(negFindings) {
    const noPrefix = [];
    const other = [];
    negFindings.forEach(f => {
        const text = f.extracted_text.replace(/\.$/, '');
        if (/^No\s+/i.test(text)) {
            noPrefix.push(text.replace(/^No\s+/i, ''));
        } else {
            other.push(f.extracted_text);
        }
    });
    let result = '';
    if (noPrefix.length === 1) {
        result += `No ${noPrefix[0]}.\n`;
    } else if (noPrefix.length === 2) {
        result += `No ${noPrefix[0]} or ${noPrefix[1]}.\n`;
    } else if (noPrefix.length > 2) {
        const last = noPrefix.pop();
        result += `No ${noPrefix.join(', ')}, or ${last}.\n`;
    }
    other.forEach(t => { result += `${t}\n`; });
    return result;
}

// Error toast (replaces alert())
function showError(message, hint) {
    const toast = document.getElementById('errorToast');
    toast.textContent = hint ? `${message} \u2014 ${hint}` : message;
    toast.classList.add('visible');
    clearTimeout(showError._timer);
    showError._timer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function dismissError() {
    const toast = document.getElementById('errorToast');
    toast.classList.remove('visible');
    clearTimeout(showError._timer);
}

// Loading message rotation
const loadingMessages = [
    'Reading report text\u2026',
    'Identifying chronic findings\u2026',
    'Mapping to MSK taxonomy\u2026',
    'Resolving temporal instances\u2026',
    'Synthesizing across reports\u2026',
];
let loadingMsgInterval = null;

function startLoadingMessages() {
    const el = document.getElementById('loadingMessage');
    if (!el) return;
    let idx = 0;
    el.textContent = loadingMessages[0];
    loadingMsgInterval = setInterval(() => {
        idx = (idx + 1) % loadingMessages.length;
        el.style.opacity = '0';
        setTimeout(() => {
            el.textContent = loadingMessages[idx];
            el.style.opacity = '1';
        }, 150);
    }, 2000);
}

function stopLoadingMessages() {
    if (loadingMsgInterval) {
        clearInterval(loadingMsgInterval);
        loadingMsgInterval = null;
    }
}

// Scoped icon refresh (avoids full DOM scan)
function refreshIcons(container) {
    if (container) {
        const nodes = container.querySelectorAll('[data-lucide]');
        if (nodes.length) lucide.createIcons({ nodes });
    } else {
        lucide.createIcons();
    }
}

// API Call Function (SSE streaming)
async function processReport() {
    const text = inputText.value.trim();
    if (!text) {
        showError('No report text entered', 'Paste one or more radiology reports into the input field');
        return;
    }

    // Reset state
    dismissError();
    requestAnimationFrame(() => processLoader.classList.add('active'));
    startLoadingMessages();
    document.getElementById('liveStatus').textContent = 'Processing report, please wait\u2026';
    processBtn.disabled = true;
    currentFindings = [];
    reportIsStreamed = true;
    structuredView.innerHTML = '<div class="p-4 text-gray-400 text-sm">Waiting for structured data\u2026</div>';
    jsonView.innerHTML = '<div class="p-4 text-gray-500 text-sm font-mono bg-gray-900 min-h-full">Waiting for structured data\u2026</div>';
    latency.textContent = '';

    // Prepare Report View for streaming
    reportView.innerHTML = '<pre id="streamPre" class="font-mono text-sm whitespace-pre-wrap break-words p-4 text-gray-800"></pre>';
    switchToReportView();

    // Mark Structured/JSON tabs as pending
    structuredViewBtn.innerHTML = 'Structured <span class="text-xs text-gray-400 animate-pulse">...</span>';
    jsonViewBtn.innerHTML = 'JSON <span class="text-xs text-gray-400 animate-pulse">...</span>';

    try {
        const response = await fetch('/api/process/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                model: modelSelect.value,
                session_id: sessionId
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const streamPre = document.getElementById('streamPre');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // Keep incomplete event in buffer

            for (const part of parts) {
                if (!part.trim()) continue;
                const lines = part.split('\n');
                let eventType = null;
                let dataStr = null;
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        dataStr = line.slice(6);
                    }
                }
                if (eventType && dataStr) {
                    const data = JSON.parse(dataStr);
                    handleSSEEvent(eventType, data, streamPre);
                }
            }
        }
    } catch (error) {
        console.error('Stream error:', error);
        showError('Failed to process report', 'Check your connection and try again');
    } finally {
        processBtn.disabled = false;
        stopLoadingMessages();
    }
}

function handleSSEEvent(eventType, data, streamPre) {
    switch (eventType) {
        case 'text':
            streamPre.textContent += data.text;
            reportView.scrollTop = reportView.scrollHeight;
            // Hide loader after first chunk
            if (processLoader.classList.contains('active')) {
                processLoader.classList.remove('active');
                stopLoadingMessages();
            }
            break;

        case 'done':
            latency.textContent = `Extract: ${data.latency_ms}ms`;
            break;

        case 'tagged':
            // Draft structured view from raw tagged findings
            currentFindings = (data.findings || []).map(f => ({
                name: f.source_text.length > 60 ? f.source_text.slice(0, 57) + '...' : f.source_text,
                taxonomy_id: f.taxonomy_id,
                taxonomy_name: f.taxonomy_name,
                category: mapTagCategory(f.taxonomy_id, f.category),
                anatomy: f.anatomy,
                assertion: f.assertion || 'positive',
                extracted_text: f.source_text,
                severity: f.severity || null,
                stability: f.stability || null,
                superseded: false,
                superseded_by: null,
                instances: f.date ? [{ date: f.date, source_text: f.source_text, assertion: f.assertion || 'positive' }] : []
            }));
            renderStructuredView();
            renderJsonView();
            refreshIcons(structuredView);
            latency.textContent = `${data.latency_ms}ms`;
            structuredViewBtn.innerHTML = 'Structured <span class="text-xs text-gray-400 animate-pulse">refining\u2026</span>';
            jsonViewBtn.innerHTML = 'JSON <span class="text-xs text-gray-400 animate-pulse">refining\u2026</span>';
            break;

        case 'structured':
            currentFindings = data.findings || [];
            renderStructuredView();
            renderJsonView();
            refreshIcons(structuredView);
            latency.textContent = `${data.latency_ms}ms`;
            // Clear pending indicators
            structuredViewBtn.textContent = 'Structured';
            jsonViewBtn.textContent = 'JSON';
            // Live region update
            document.getElementById('liveStatus').textContent =
                `Processing complete. ${currentFindings.length} findings extracted.`;
            // Success pulse
            const outputContainer = reportView.closest('.relative');
            if (outputContainer) {
                outputContainer.style.boxShadow = '0 0 0 2px var(--accent-600)';
                setTimeout(() => { outputContainer.style.boxShadow = ''; }, 1500);
            }
            break;

        case 'error':
            processLoader.classList.remove('active');
            stopLoadingMessages();
            showError(data.message);
            document.getElementById('liveStatus').textContent = `Error: ${data.message}`;
            break;
    }
}

// Render Report View (anatomy-grouped plain text)
function renderReportView() {
    if (currentFindings.length === 0) {
        reportView.innerHTML = '<div class="p-4 text-gray-500">No findings extracted.</div>';
        return;
    }

    // Clinical ordering: categories rendered in this order, with each category's
    // negatives appearing inline right after its positives
    const categoryOrder = [
        'hardware',       // 1. Hardware/arthroplasty
        'fracture',       // 2. Fracture findings + "no fracture or dislocation"
        'alignment',      // 3. Alignment/mortise
        'degenerative',   // 4. Degenerative changes
        'soft_tissue',    // 5. Soft tissue
        'metabolic',      // 6. Bone quality (osteopenia)
        'osseous_lesion',
        'osseous',
        'inflammatory',
        'postsurgical',
        'variant',
    ];

    // Group findings by anatomy, then by category within each anatomy
    const grouped = {};
    currentFindings.forEach(finding => {
        if (finding.superseded) return;
        if (!grouped[finding.anatomy]) grouped[finding.anatomy] = {};
        const cat = finding.category;
        if (!grouped[finding.anatomy][cat]) grouped[finding.anatomy][cat] = { positive: [], negative: [] };
        if (finding.assertion === 'negative') {
            grouped[finding.anatomy][cat].negative.push(finding);
        } else {
            grouped[finding.anatomy][cat].positive.push(finding);
        }
    });

    // Build plain text output — interleave positives and negatives by category
    let html = '<pre class="font-mono text-sm whitespace-pre-wrap break-words p-4 text-gray-800">';

    Object.entries(grouped).forEach(([anatomy, categories]) => {
        // Check if any findings exist
        const hasFindings = Object.values(categories).some(g => g.positive.length > 0 || g.negative.length > 0);
        if (!hasFindings) return;

        html += `<strong>${anatomy}:</strong>\n`;

        for (const cat of categoryOrder) {
            const group = categories[cat];
            if (!group) continue;

            // Positive findings for this category
            group.positive.forEach(finding => {
                html += `${finding.extracted_text}\n`;
            });

            // Negative findings for this category, inline
            if (group.negative.length > 0) {
                html += formatNegatives(group.negative);
            }
        }

        // Any categories not in categoryOrder (shouldn't happen, but safe)
        for (const cat of Object.keys(categories)) {
            if (categoryOrder.includes(cat)) continue;
            const group = categories[cat];
            group.positive.forEach(f => { html += `${f.extracted_text}\n`; });
            if (group.negative.length > 0) html += formatNegatives(group.negative);
        }

        html += '\n';
    });

    html += '</pre>';
    reportView.innerHTML = html;
}

// Render Structured View (entity cards with instances)
function renderStructuredView() {
    if (currentFindings.length === 0) {
        structuredView.innerHTML = '<div class="p-4 text-gray-500">No findings extracted.</div>';
        return;
    }

    let html = '<div class="p-4 space-y-4">';

    // Active findings (split by assertion)
    const activePositive = currentFindings.filter(f => !f.superseded && f.assertion !== 'negative');
    const activeNegative = currentFindings.filter(f => !f.superseded && f.assertion === 'negative');
    const supersededFindings = currentFindings.filter(f => f.superseded);

    // Positive findings
    let cardIndex = 0;
    if (activePositive.length > 0) {
        activePositive.forEach(finding => {
            html += renderFindingCard(finding, false, cardIndex++);
        });
    }

    // Negative findings (pertinent negatives)
    if (activeNegative.length > 0) {
        html += '<div class="mt-6 pt-4 border-t border-gray-300">';
        html += '<h3 class="text-sm font-semibold text-gray-600 mb-3">Pertinent Negatives</h3>';
        activeNegative.forEach(finding => {
            html += renderFindingCard(finding, false, cardIndex++);
        });
        html += '</div>';
    }

    // Superseded findings section
    if (supersededFindings.length > 0) {
        html += '<div class="mt-6 pt-4 border-t border-gray-300">';
        html += '<h3 class="text-sm font-semibold text-gray-600 mb-3">Superseded Findings</h3>';
        supersededFindings.forEach(finding => {
            html += renderFindingCard(finding, true, cardIndex++);
        });
        html += '</div>';
    }

    html += '</div>';
    structuredView.innerHTML = html;
}

function renderFindingCard(finding, isSuperseded, index) {
    const isNegative = finding.assertion === 'negative';
    const opacityClass = isSuperseded ? 'opacity-50' : '';
    const cardBg = isNegative ? 'bg-gray-50 border-gray-200' : 'border-gray-300';
    const delay = (index || 0) * 40;

    let html = `<div class="finding-card border rounded-lg p-4 ${cardBg} ${opacityClass}" style="animation-delay: ${delay}ms">`;

    // Header with category badge, assertion badge, and anatomy
    html += `<div class="flex items-start justify-between mb-2">`;
    html += `<div class="flex items-start gap-2">`;
    html += `<span class="category-badge" data-category="${finding.category}">${finding.category}</span>`;
    if (isNegative) {
        html += `<span class="inline-block px-2 py-1 text-xs font-semibold rounded border bg-slate-200 text-slate-600 border-slate-300">NEG</span>`;
    }
    html += `<span class="text-xs text-gray-600 font-mono">${finding.taxonomy_id}</span>`;
    html += `</div>`;
    html += `<span class="text-xs text-gray-600 font-medium">${finding.anatomy}</span>`;
    html += `</div>`;

    // Finding name
    const nameColor = isNegative ? 'text-gray-700' : 'text-gray-900';
    html += `<div class="font-semibold ${nameColor} mb-1">${finding.name}</div>`;

    // Extracted text
    const textColor = isNegative ? 'text-gray-600' : 'text-gray-800';
    html += `<div class="text-sm ${textColor} mb-2 italic">"${finding.extracted_text}"</div>`;

    // Superseded reason
    if (isSuperseded && finding.superseded_by) {
        html += `<div class="text-xs text-gray-600 mb-2 italic">Superseded by: ${finding.superseded_by}</div>`;
    }

    // Instances (collapsible)
    if (finding.instances && finding.instances.length > 0) {
        const instanceId = `instances_${Math.random().toString(36).slice(2, 9)}`;
        html += `<div class="mt-3 pt-3 border-t border-gray-200">`;
        html += `<button onclick="toggleInstances('${instanceId}')" aria-expanded="false" class="text-xs font-medium text-gray-700 hover:text-gray-900 flex items-center gap-1">`;
        html += `<i data-lucide="chevron-right" class="w-4 h-4 instance-chevron" id="chev_${instanceId}"></i>`;
        html += `${finding.instances.length} instance${finding.instances.length !== 1 ? 's' : ''}`;
        html += `</button>`;
        html += `<div id="${instanceId}" class="hidden mt-2 space-y-2">`;

        finding.instances.forEach(instance => {
            html += `<div class="text-xs bg-gray-50 p-2 rounded border border-gray-200">`;
            if (instance.date) {
                html += `<span class="font-mono text-gray-600">${instance.date}</span><br>`;
            }
            html += `<span class="text-gray-700">${escapeHtml(instance.source_text)}</span>`;
            html += `</div>`;
        });

        html += `</div></div>`;
    }

    html += `</div>`;
    return html;
}

function renderJsonView() {
    if (currentFindings.length === 0) {
        jsonView.innerHTML = '<div class="p-4 text-gray-500 text-sm font-mono bg-gray-900 min-h-full">No findings extracted.</div>';
        return;
    }

    const jsonObj = { findings: currentFindings };
    const jsonStr = JSON.stringify(jsonObj, null, 2);

    const colorized = escapeHtml(jsonStr)
        .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
        .replace(/: "([^"]*?)"/g, ': <span class="json-string">"$1"</span>')
        .replace(/: (null)/g, ': <span class="json-null">$1</span>')
        .replace(/: (true|false|\d+)/g, ': <span class="json-number">$1</span>');

    jsonView.innerHTML = `<pre class="p-4 font-mono text-sm text-gray-400 whitespace-pre-wrap break-words bg-gray-900 min-h-full">${colorized}</pre>`;
}

function toggleInstances(elementId) {
    const elem = document.getElementById(elementId);
    const chev = document.getElementById('chev_' + elementId);
    const btn = chev?.closest('button');
    if (elem) {
        const isHidden = elem.classList.toggle('hidden');
        if (chev) chev.style.transform = isHidden ? '' : 'rotate(90deg)';
        if (btn) btn.setAttribute('aria-expanded', !isHidden);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// View Toggle
const allViews = () => [reportView, structuredView, jsonView];
const allViewBtns = () => [reportViewBtn, structuredViewBtn, jsonViewBtn];

function activateView(activeView, activeBtn) {
    allViews().forEach(v => v.classList.remove('active'));
    allViewBtns().forEach(b => {
        b.removeAttribute('data-active');
        b.setAttribute('aria-selected', 'false');
    });
    activeView.classList.add('active');
    activeBtn.setAttribute('data-active', '');
    activeBtn.setAttribute('aria-selected', 'true');
}

function switchToReportView() { activateView(reportView, reportViewBtn); }
function switchToStructuredView() { activateView(structuredView, structuredViewBtn); }
function switchToJsonView() { activateView(jsonView, jsonViewBtn); }

// Copy to Clipboard
let copyInProgress = false;

async function copyToClipboard() {
    const reportText = reportView.innerText;
    if (!reportText || reportText.includes('will appear here') || copyInProgress) return;

    copyInProgress = true;

    try {
        await navigator.clipboard.writeText(reportText);

        // Success animation
        copyBtn.style.transition = 'opacity 150ms ease';
        copyBtn.style.opacity = '0';
        setTimeout(() => {
            copyBtn.classList.remove('text-gray-600');
            copyBtn.classList.add('text-green-600');
            copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span class="text-xs font-medium">Copied</span>';
            refreshIcons(copyBtn);
            copyBtn.style.opacity = '1';
        }, 150);

        setTimeout(() => {
            copyBtn.style.opacity = '0';
            setTimeout(() => {
                copyBtn.classList.remove('text-green-600');
                copyBtn.classList.add('text-gray-600');
                copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i><span class="text-xs font-medium">Copy</span>';
                refreshIcons(copyBtn);
                copyBtn.style.opacity = '1';
                copyInProgress = false;
            }, 150);
        }, 1500);
    } catch (err) {
        console.error('Copy failed:', err);
        showError('Copy failed', 'Try selecting text manually with Ctrl+A, Ctrl+C');
        copyInProgress = false;
    }
}

// Event Listeners
processBtn.addEventListener('click', processReport);
reportViewBtn.addEventListener('click', switchToReportView);
structuredViewBtn.addEventListener('click', switchToStructuredView);
jsonViewBtn.addEventListener('click', switchToJsonView);
copyBtn.addEventListener('click', copyToClipboard);
// Keyboard shortcut: Ctrl/Cmd + Enter to process
inputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        processReport();
    }
});

// Arrow key navigation for view tabs (WAI-ARIA tablist pattern)
const tabButtons = [reportViewBtn, structuredViewBtn, jsonViewBtn];
const tabSwitchers = [switchToReportView, switchToStructuredView, switchToJsonView];
tabButtons.forEach((btn, i) => {
    btn.addEventListener('keydown', (e) => {
        let nextIndex = i;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            nextIndex = (i + 1) % tabButtons.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            nextIndex = (i - 1 + tabButtons.length) % tabButtons.length;
        } else {
            return;
        }
        e.preventDefault();
        tabButtons[nextIndex].focus();
        tabSwitchers[nextIndex]();
    });
});

// --- Taxonomy Modal ---
const taxonomyBtn = document.getElementById('taxonomyBtn');
const taxonomyModal = document.getElementById('taxonomyModal');
const taxonomyTree = document.getElementById('taxonomyTree');
const taxonomyCount = document.getElementById('taxonomyCount');
let taxonomyData = null;

const taxonomyCategoryColors = {
    extrinsic: { bg: 'bg-slate-50', border: 'border-slate-200', badge: 'bg-slate-100 text-slate-700' },
    osseous: { bg: 'bg-stone-50', border: 'border-stone-200', badge: 'bg-stone-100 text-stone-700' },
    alignment: { bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-100 text-purple-700' },
    articular: { bg: 'bg-indigo-50', border: 'border-indigo-200', badge: 'bg-indigo-100 text-indigo-700' },
    soft_tissue: { bg: 'bg-teal-50', border: 'border-teal-200', badge: 'bg-teal-100 text-teal-700' },
    technique: { bg: 'bg-gray-50', border: 'border-gray-200', badge: 'bg-gray-100 text-gray-600' },
};

function getTaxonomyColor(category) {
    return taxonomyCategoryColors[category] || taxonomyCategoryColors.technique;
}

function renderTaxonomyNode(node, depth) {
    const hasChildren = node.children && node.children.length > 0;
    const colors = getTaxonomyColor(node.category);
    const indent = depth * 20;

    let html = `<div class="taxonomy-node" style="padding-left:${indent}px">`;
    html += `<div class="flex items-center gap-2 py-1 group">`;

    const toggleId = hasChildren ? `tax_${node.id}` : null;
    const clickAttr = toggleId ? `onclick="toggleTaxonomyNode('${toggleId}')"` : '';
    const cursorClass = hasChildren ? 'cursor-pointer' : '';

    if (hasChildren) {
        html += `<span ${clickAttr} class="flex-none w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600 ${cursorClass}">`;
        html += `<i data-lucide="chevron-right" class="w-3 h-3 taxonomy-chevron" id="chev_${toggleId}"></i>`;
        html += `</span>`;
    } else {
        html += `<span class="flex-none w-4"></span>`;
    }

    // Name (clickable for parents)
    const nameWeight = hasChildren && !node.finding_type ? 'font-semibold text-gray-800' : 'text-gray-700';
    html += `<span ${clickAttr} class="${nameWeight} text-sm ${cursorClass} select-none">${node.name.replace(/_/g, ' ')}</span>`;

    // Finding type badge
    if (node.finding_type === 'observation') {
        html += `<span class="text-[10px] font-medium text-blue-600 bg-blue-50 px-1 rounded">obs</span>`;
    } else if (node.finding_type === 'diagnosis') {
        html += `<span class="text-[10px] font-medium text-amber-600 bg-amber-50 px-1 rounded">dx</span>`;
    }

    // ID (subtle)
    html += `<span class="text-[10px] text-gray-400 font-mono opacity-0 group-hover:opacity-100 transition-opacity">${node.id}</span>`;

    // Synonyms on hover
    if (node.synonyms) {
        const synList = node.synonyms.split(',').slice(0, 4).map(s => s.trim()).join(', ');
        const more = node.synonyms.split(',').length > 4 ? '...' : '';
        html += `<span class="text-[10px] text-gray-400 italic opacity-0 group-hover:opacity-100 transition-opacity truncate max-w-[250px]">${synList}${more}</span>`;
    }

    html += `</div>`;

    if (hasChildren) {
        const toggleId = `tax_${node.id}`;
        html += `<div id="${toggleId}" class="taxonomy-children">`;
        html += `<div>`;
        node.children.forEach(child => {
            html += renderTaxonomyNode(child, depth + 1);
        });
        html += `</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

function toggleTaxonomyNode(toggleId) {
    const el = document.getElementById(toggleId);
    const chev = document.getElementById('chev_' + toggleId);
    if (el) {
        el.classList.toggle('expanded');
        if (chev) {
            chev.style.transform = el.classList.contains('expanded') ? 'rotate(90deg)' : '';
        }
    }
}

function expandAllTaxonomy() {
    taxonomyTree.querySelectorAll('[id^="tax_MID"]').forEach(el => {
        el.classList.add('expanded');
    });
    taxonomyTree.querySelectorAll('[id^="chev_tax_MID"]').forEach(el => {
        el.style.transform = 'rotate(90deg)';
    });
}

function collapseAllTaxonomy() {
    taxonomyTree.querySelectorAll('[id^="tax_MID"]').forEach(el => {
        el.classList.remove('expanded');
    });
    taxonomyTree.querySelectorAll('[id^="chev_tax_MID"]').forEach(el => {
        el.style.transform = '';
    });
}

function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const focusables = taxonomyModal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

async function openTaxonomyModal() {
    taxonomyModal.classList.remove('pointer-events-none');
    requestAnimationFrame(() => {
        taxonomyModal.querySelector('.modal-backdrop').classList.add('active');
        taxonomyModal.querySelector('.modal-content').classList.add('active');
    });
    document.body.style.overflow = 'hidden';
    taxonomyModal.addEventListener('keydown', trapFocus);

    if (!taxonomyData) {
        const resp = await fetch('/api/taxonomy');
        taxonomyData = await resp.json();
    }

    taxonomyCount.textContent = `${taxonomyData.total} findings across ${taxonomyData.tree.length} root categories`;

    // Group roots by category
    const categoryOrder = ['extrinsic', 'osseous', 'alignment', 'articular', 'soft_tissue', 'technique'];
    const byCategory = {};
    taxonomyData.tree.forEach(node => {
        const cat = node.category || 'other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(node);
    });

    let html = '';
    for (const cat of categoryOrder) {
        const nodes = byCategory[cat];
        if (!nodes) continue;
        const colors = getTaxonomyColor(cat);
        const label = cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        html += `<div class="mb-4">`;
        html += `<div class="text-xs font-bold uppercase tracking-wider ${colors.badge} inline-block px-2 py-0.5 rounded mb-2">${label}</div>`;
        nodes.forEach(node => {
            html += renderTaxonomyNode(node, 0);
        });
        html += `</div>`;
    }

    taxonomyTree.innerHTML = html;
    refreshIcons(taxonomyTree);

    // Focus first focusable element in modal
    const firstBtn = taxonomyModal.querySelector('.modal-content button');
    if (firstBtn) firstBtn.focus();
}

function closeTaxonomyModal() {
    const backdrop = taxonomyModal.querySelector('.modal-backdrop');
    const content = taxonomyModal.querySelector('.modal-content');
    backdrop.classList.remove('active');
    content.classList.remove('active');
    content.addEventListener('transitionend', () => {
        taxonomyModal.classList.add('pointer-events-none');
    }, { once: true });
    document.body.style.overflow = '';
    taxonomyModal.removeEventListener('keydown', trapFocus);
    taxonomyBtn.focus(); // return focus to trigger
}

taxonomyBtn.addEventListener('click', openTaxonomyModal);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !taxonomyModal.classList.contains('pointer-events-none')) {
        closeTaxonomyModal();
    }
});
