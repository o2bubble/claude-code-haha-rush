import * as d3 from 'd3';

const TYPE_COLORS = {
  fact: '#0075de',
  experience: '#1aae39',
  lesson: '#dd5b00',
};

const EDGE_COLORS = {
  related_to: '#615d59',
  derived_from: '#0075de',
  contradicts: '#dc2626',
  supports: '#1aae39',
};

export function createSimulation(nodes, { width, height }) {
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink().id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(30));

  return simulation;
}

export function renderGraph(svgEl, { nodes, edges, highlightedIds, onNodeClick, getSize, colors }) {
  const width = getSize().width;
  const height = getSize().height;
  const { typeColors = TYPE_COLORS, edgeColors = EDGE_COLORS, nodeStroke = '#0d1117', labelFill = '#c9d1d9' } = colors || {};

  // highlightedIds: when non-null, only matching nodes are bright; others are dimmed
  const hasHighlight = highlightedIds && highlightedIds.size > 0;

  const svg = d3.select(svgEl)
    .attr('viewBox', [0, 0, width, height]);

  // Clear
  svg.selectAll('*').remove();

  const g = svg.append('g');

  // Zoom
  svg.call(d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    }));

  // Edge definitions
  const linkMap = new Map();
  const linkData = [];
  for (const e of edges) {
    const key = [e.source_id || e.source, e.target_id || e.target].sort().join('::');
    if (!linkMap.has(key)) {
      linkMap.set(key, true);
      linkData.push({
        source: e.source_id || e.source,
        target: e.target_id || e.target,
        type: e.type || 'related_to',
        weight: e.weight || 0.5,
      });
    }
  }

  const simulation = createSimulation(nodes, { width, height });
  simulation.force('link').links(linkData);

  const link = g.append('g')
    .selectAll('line')
    .data(linkData)
    .join('line')
    .attr('stroke', d => edgeColors[d.type] || '#8b949e')
    .attr('stroke-opacity', d => {
      const base = 0.3 + d.weight * 0.5;
      if (!hasHighlight) return base;
      const sid = d.source?.id || d.source;
      const tid = d.target?.id || d.target;
      const either = highlightedIds.has(sid) || highlightedIds.has(tid);
      return either ? base * 0.6 : 0.05;
    })
    .attr('stroke-width', d => 1 + d.weight * 2);

  const node = g.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .style('cursor', 'pointer')
    .style('opacity', d => hasHighlight ? (highlightedIds.has(d.id) ? 1 : 0.15) : 1)
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }));

  node.append('circle')
    .attr('r', d => 6 + d.importance * 10)
    .attr('fill', d => typeColors[d.type] || '#8b949e')
    .attr('stroke', nodeStroke)
    .attr('stroke-width', d => hasHighlight && highlightedIds.has(d.id) ? 3 : 2);

  node.append('text')
    .text(d => d.title?.length > 25 ? d.title.slice(0, 25) + '...' : d.title || '')
    .attr('x', 12)
    .attr('y', 3)
    .attr('fill', labelFill)
    .attr('font-size', 11)
    .attr('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');

  node.on('click', (event, d) => {
    event.stopPropagation();
    onNodeClick(d.id);
  });

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  return simulation;
}

export function renderSubGraph(containerEl, { nodes, edges, onNodeClick, colors }) {
  try {
    const { typeColors = TYPE_COLORS, nodeStroke = '#fff', labelFill = '#333' } = colors || {};
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    if (width === 0 || height === 0) return null;

    const nodeIds = new Set(nodes.map((n) => n.id));
    const linkData = edges
      .filter((e) => nodeIds.has(e.source_id || e.source) && nodeIds.has(e.target_id || e.target))
      .map((e) => ({ source: e.source_id || e.source, target: e.target_id || e.target }));
    if (linkData.length === 0) return null;

    const svg = d3.select(containerEl).html('').append('svg')
      .attr('width', width).attr('height', height);

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink().id(d => d.id).distance(60))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(18));

    simulation.force('link').links(linkData);

    const g = svg.append('g');

    const link = g.selectAll('line').data(linkData).join('line')
      .attr('stroke', '#615d59').attr('stroke-opacity', 0.4).attr('stroke-width', 1.5);

    const node = g.selectAll('g').data(nodes).join('g')
      .style('cursor', 'pointer')
      .on('click', (event, d) => { event.stopPropagation(); onNodeClick(d.id); });

    node.append('circle')
      .attr('r', d => d.id === nodes[0]?.id ? 10 : 7)
      .attr('fill', d => typeColors[d.type] || '#8b949e')
      .attr('stroke', nodeStroke)
      .attr('stroke-width', 1.5);

    node.append('text')
      .text(d => (d.title || '').length > 15 ? d.title.slice(0, 15) + '...' : d.title || '')
      .attr('x', 13).attr('y', 3)
      .attr('fill', labelFill)
      .attr('font-size', 9)
      .attr('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');

    simulation.on('tick', () => {
      link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    return simulation;
  } catch (e) {
    console.error('renderSubGraph:', e);
    return null;
  }
}
