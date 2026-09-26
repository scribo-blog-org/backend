// @ts-check

import eslint from "@eslint/js"
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "coverage/**",
            "test/**",
            "eslint.config.mjs"
        ]
    },

    {
        files: ["src/**/*.ts"]
    },

    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettierRecommended,

    {
        files: ["src/**/*.mjs"],
        languageOptions: {
            globals: {
                ...globals.node
            },
            sourceType: "module"
        }
    },

    {
        files: ["src/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest
            },
            sourceType: "module",
            parserOptions: {
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "none"
                }
            ],
            "prettier/prettier": ["error", { endOfLine: "auto" }]
        }
    }
)
