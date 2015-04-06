(ns bunsen.marketplace.api.domain
  (:require [bunsen.marketplace.base :as base]
            [bunsen.marketplace.categories :as cats]
            [bunsen.marketplace.datasets :as datasets]
            [bunsen.marketplace.mappings :as mappings]
            [bunsen.marketplace.simple.simple :as simple]
            [clojurewerkz.elastisch.rest :as rest]
            [clojurewerkz.elastisch.rest.index :as ind]
            [clojurewerkz.elastisch.rest.document :as doc]
            [clojurewerkz.elastisch.query :as query]
            [clojurewerkz.elastisch.aggregation :as agg]
            [clojurewerkz.elastisch.rest.response :refer :all]))

(defn connect-to-es
  [config]
  (rest/connect
    (:elasticsearch-url config)
    (:elasticsearch-options config)))

(defn update-marketplace
  "Performs some common pre-processing tasks before kicking off the
  specified marketplace work.
  config = application config instance
  body = string representation of request body
  biz-fn = business task that we intend to perform"
  [config body biz-fn]
  (let [es-conn (connect-to-es config)
        index-name (:indexName body)]
    (biz-fn es-conn index-name body)))

(defn get-status [ctx] "ok")

(defn get-formats
  "Aggregates all unique formats used within datasets.
  However we do not pass an index since we want all indices' formats"
  [config]
  (let [es-conn (connect-to-es config)
        response (doc/search es-conn "*" "datasets"
                             :query (query/match-all)
                             :aggregations  {:title_terms  (agg/terms  "format")})
        aggregation (aggregation-from response :title_terms)]
    (map :key (:buckets aggregation))))

(defn get-categories
  "Returns all categories from specified index by search-term
  index-name = index which category belongs to
  search-term = three or more characters which will search against category name"
  [config params]
  (let [categories (doc/search (connect-to-es config)
                               (:index-name params)
                               "categories"
                               :query {:fuzzy_like_this_field {"name" {:like_text (:search-term params)}}})]

    (map #(select-keys (:_source %) [:id :name]) (-> categories :hits :hits))))

(defn create-categories
  "Returns true if categories payload was succesfully sent to
  ElasticSearch, false otherwise."
  [es-conn index-name payload]
  (let [categories (:categories payload)
        indexer (base/index! es-conn index-name "categories" categories
                             identity ; json already parsed
                             cats/add-id-for-elastisch
                             base/bulk-to-es!)]
    (await-for 5000 indexer)
    (= (:stage @indexer) :indexed)))

(defn create-datasets
  "Returns true if datasets payload was succesfully sent to
  ElasticSearch, false otherwise."
  [es-conn index-name payload]
  (let [datasets (:datasets payload)
        categories (base/read-indexed-results es-conn index-name "categories")
        indexer (base/index! es-conn index-name "datasets" datasets
                             identity ; json already parsed
                             (fn [result]
                               (map (partial simple/prepare-dataset categories)
                                    result))
                             base/bulk-to-es!)]
    (await-for 5000 indexer)
    (= (:stage @indexer) :indexed)))

(defn delete-dataset
  [config index-name id]
  (-> (connect-to-es config) (doc/delete index-name "datasets" id)))

(defn update-dataset
  "Updates dataset with given payload"
  [config index-name id document]
  (-> (connect-to-es config) (doc/put index-name "datasets" id document)))

(defn update-counts
  [es-conn index-name payload]
  (let [categories (base/read-indexed-results es-conn index-name "categories")]
    (cats/update-counts! es-conn index-name categories)))

(defn update-mappings
  "Updates the ElasticSearch mappings necessary for the index's catalog
  metadata"
  [es-conn index-name payload]
  (let [categories (base/read-indexed-results es-conn index-name "categories")]
    (cats/update-mappings! es-conn index-name categories)))

(defn refresh-index
  [es-conn index-name payload]
  (ind/refresh es-conn index-name))

(defn get-indicies
  [config _]
  (keys (ind/get-aliases (connect-to-es config) "*")))

(defn create-index
  [es-conn index-name payload]
  (ind/delete es-conn index-name)
  (ind/create es-conn index-name)
  (mappings/apply-mappings! es-conn index-name "simple/mappings.json"))
