figma.showUI(__html__, {
  width: 860,
  height: 720,
  themeColors: true,
});

function colorToHex(color) {
  var toHex = function (value) {
    var hex = Math.round(value * 255).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };
  var alpha = typeof color.a === "number" ? toHex(color.a) : "";
  return "#" + toHex(color.r) + toHex(color.g) + toHex(color.b) + alpha;
}

function normalizeValue(value) {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(function (item) {
      return normalizeValue(item);
    });
  }

  if (
    typeof value.r === "number" &&
    typeof value.g === "number" &&
    typeof value.b === "number"
  ) {
    var colorValue = {};
    for (var colorKey in value) {
      if (Object.prototype.hasOwnProperty.call(value, colorKey)) {
        colorValue[colorKey] = value[colorKey];
      }
    }
    colorValue.hex = colorToHex(value);
    return colorValue;
  }

  if (value.type === "VARIABLE_ALIAS") {
    return {
      type: value.type,
      id: value.id,
    };
  }

  var normalized = {};
  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      normalized[key] = normalizeValue(value[key]);
    }
  }
  return normalized;
}

function serializeCollection(collection) {
  return {
    id: collection.id,
    key: collection.key,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map(function (mode) {
      return {
        modeId: mode.modeId,
        name: mode.name,
      };
    }),
    variableIds: collection.variableIds ? collection.variableIds.slice() : [],
    remote: collection.remote,
    hiddenFromPublishing: collection.hiddenFromPublishing,
  };
}

function serializeVariable(variable) {
  return {
    id: variable.id,
    key: variable.key,
    name: variable.name,
    description: variable.description,
    resolvedType: variable.resolvedType,
    variableCollectionId: variable.variableCollectionId,
    valuesByMode: normalizeValue(variable.valuesByMode),
    scopes: variable.scopes ? variable.scopes.slice() : [],
    remote: variable.remote,
    hiddenFromPublishing: variable.hiddenFromPublishing,
    codeSyntax: variable.codeSyntax,
  };
}

function serializePaintStyle(style) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    remote: style.remote,
    type: style.type,
    paints: normalizeValue(style.paints),
  };
}

function serializeTextStyle(style) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    remote: style.remote,
    type: style.type,
    fontName: normalizeValue(style.fontName),
    fontSize: style.fontSize,
    lineHeight: normalizeValue(style.lineHeight),
    letterSpacing: normalizeValue(style.letterSpacing),
    paragraphIndent: style.paragraphIndent,
    paragraphSpacing: style.paragraphSpacing,
    textCase: style.textCase,
    textDecoration: style.textDecoration,
  };
}

function serializeEffectStyle(style) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    remote: style.remote,
    type: style.type,
    effects: normalizeValue(style.effects),
  };
}

function serializeGridStyle(style) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    remote: style.remote,
    type: style.type,
    layoutGrids: normalizeValue(style.layoutGrids),
  };
}

async function exportTeamLibraryVariables() {
  if (!figma.teamLibrary || !figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync) {
    return {
      supported: false,
      collections: [],
    };
  }

  var collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  var serializedCollections = [];

  for (var index = 0; index < collections.length; index += 1) {
    var collection = collections[index];
    var variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
    serializedCollections.push({
      key: collection.key,
      name: collection.name,
      libraryName: collection.libraryName,
      variables: variables.map(function (variable) {
        return {
          key: variable.key,
          name: variable.name,
          resolvedType: variable.resolvedType,
        };
      }),
    });
  }

  return {
    supported: true,
    collections: serializedCollections,
  };
}

async function exportDesignData(options) {
  var results = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);
  var collections = results[0];
  var variables = results[1];
  var paintStyles = results[2];
  var textStyles = results[3];
  var effectStyles = results[4];
  var gridStyles = results[5];

  return {
    schemaVersion: 1,
    exporter: "TDS Variables Exporter",
    exportedAt: new Date().toISOString(),
    file: {
      name: figma.root.name,
      currentPageName: figma.currentPage.name,
    },
    variables: {
      collections: collections.map(serializeCollection),
      items: variables.map(serializeVariable),
    },
    styles: {
      paints: paintStyles.map(serializePaintStyle),
      texts: textStyles.map(serializeTextStyle),
      effects: effectStyles.map(serializeEffectStyle),
      grids: gridStyles.map(serializeGridStyle),
    },
    teamLibraryVariables: options.includeTeamLibrary
      ? await exportTeamLibraryVariables()
      : {
          skipped: true,
          collections: [],
        },
  };
}

figma.ui.onmessage = async function (message) {
  if (message.type === "close") {
    figma.closePlugin();
    return;
  }

  if (message.type !== "export") return;

  try {
    var payload = await exportDesignData({
      includeTeamLibrary: Boolean(message.includeTeamLibrary),
    });
    figma.ui.postMessage({
      type: "export:success",
      payload,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "export:error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
